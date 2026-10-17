import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  clearEmbeddedSessionPromptStates,
  prepareSessionSystemPrompt,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { installAttemptPermissionPrompt } from "./attempt-permission-prompt.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt foreground dispatch", () => {
  it.each(["tool", "steer", "steer-backlog", "cancelled", "initial-backlog", "agent-end"] as const)(
    "refreshes permissions only for admitted %s continuation input",
    async (continuation) => {
      const model = {
        ...testModel,
        provider: "anthropic",
        api: "anthropic-messages" as const,
        id: "claude-opus-5",
      };
      const { session, sessionManager } = await createTestSession({
        model,
        customTools: [
          {
            name: "read",
            label: "Read",
            description: "Read a fixture",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
          },
        ],
      });
      if (continuation === "steer") {
        session.agent.steeringMode = "all";
      }
      const input = createBaseInput();
      const pinnedPrompt = "## Tools\nread, write";
      session.setBaseSystemPrompt(pinnedPrompt);
      let currentPrompt = pinnedPrompt;
      const prepareSystemPromptUpdate = (systemPrompt: string) =>
        prepareSessionSystemPrompt({
          state: input.sessionPromptState,
          routeKey: "anthropic/claude-opus-5/anthropic-messages",
          systemPrompt,
          entries: sessionManager.getBranch(),
        });
      const setPreparation = installAttemptPermissionPrompt({
        activeSession: session,
        attempt: { model: { api: "anthropic-messages" } },
        runAbortSignal: new AbortController().signal,
        setActiveSessionSystemPrompt: (prompt) => {
          session.setBaseSystemPrompt(prompt);
          return prompt;
        },
        prepareSystemPromptUpdate,
      });
      setPreparation(async () => () => currentPrompt);
      const queuedUser = {
        role: "user" as const,
        content: "Continue after the permission change.",
        timestamp: 2,
      };
      const initial = continuation === "initial-backlog";
      if (initial) {
        prepareSystemPromptUpdate(pinnedPrompt).commit();
        await persistSessionSystemPrompt(input.sessionPromptState, (customType, data) =>
          sessionManager.appendCustomEntryAsync(customType, data),
        );
        currentPrompt = "## Tools\nread";
        session.agent.steer(queuedUser);
        if (continuation === "initial-backlog") {
          session.agent.steer({ role: "user", content: "A later queued request.", timestamp: 3 });
        }
      }
      let finishedTurns = 0;
      let recovered = false;
      session.agent.subscribe(async (event) => {
        if (continuation === "agent-end" && event.type === "agent_end" && !recovered) {
          recovered = true;
          session.agent.steer(queuedUser);
        }
        if (
          event.type === "message_start" &&
          event.message === queuedUser &&
          continuation === "cancelled"
        ) {
          session.agent.cancelSteeringMessage((message) => message === queuedUser);
        }
        if (event.type !== "turn_end" || ++finishedTurns !== 1) {
          return;
        }
        currentPrompt = "## Tools\nread";
        if (
          continuation === "steer" ||
          continuation === "steer-backlog" ||
          continuation === "cancelled"
        ) {
          session.agent.steer(queuedUser);
          if (continuation === "steer-backlog") {
            session.agent.steer({ role: "user", content: "A later queued request.", timestamp: 3 });
          }
          if (continuation === "steer") {
            await session.sendCustomMessage(
              {
                customType: "extension-context",
                content: "Queued extension context.",
                display: false,
              },
              { deliverAs: "steer" },
            );
          }
        }
      });
      const baseConvert = session.agent.convertToLlm;
      session.agent.convertToLlm = (messages) =>
        baseConvert(
          normalizeMessagesForLlmBoundary(messages, {
            inHistorySystemUpdates: true,
            appendOnlyRuntimeContext: true,
            includeTimestamp: false,
          }),
        );
      const requests: Context[] = [];
      streamMocks.streamSimple.mockImplementation((activeModel, context: Context) => {
        requests.push({ ...context, messages: structuredClone(context.messages) });
        const useTool = continuation === "tool" && requests.length === 1;
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            useTool
              ? [{ type: "toolCall", id: "read-fixture", name: "read", arguments: {} }]
              : [{ type: "text", text: "Done." }],
            useTool ? "toolUse" : "stop",
          ),
        );
      });
      await submitEmbeddedAttemptPrompt({
        ...input,
        activeSession: session,
        prependContext: undefined,
        appendContext: undefined,
        ...(initial
          ? {
              appendOnlyRuntimeContext: true,
              runtimeContextMessage: buildRuntimeContextCustomMessage(
                "Runtime at initial admission.",
                undefined,
                true,
              ),
            }
          : {}),
        persistToolResultProjections: () =>
          persistSessionSystemPrompt(input.sessionPromptState, (customType, data) =>
            sessionManager.appendCustomEntryAsync(customType, data),
          ),
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
      const updates = sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "openclaw.system-update",
        );
      if (continuation === "cancelled") {
        expect(requests).toHaveLength(1);
        expect(updates).toHaveLength(0);
      } else {
        const expectedRequests = continuation === "steer-backlog" ? 3 : 2;
        expect(requests).toHaveLength(expectedRequests);
        expect(updates).toHaveLength(initial ? 2 : 1);
        expect(requests.map((request) => request.systemPrompt)).toEqual(
          Array.from({ length: expectedRequests }, () => pinnedPrompt),
        );
        const messages =
          requests[initial ? 0 : continuation === "steer-backlog" ? 1 : expectedRequests - 1]!
            .messages;
        expect(messages.at(-1)).toMatchObject({
          role: "user",
          operatorMessage: { turnScoped: false },
          content: expect.stringContaining("## Tools\nread"),
        });
        if (continuation === "tool") {
          expect(messages.at(-2)?.role).toBe("toolResult");
        } else {
          expect(
            JSON.stringify(messages.at(continuation === "steer" || initial ? -3 : -2)),
          ).toContain(queuedUser.content);
        }
        if (continuation === "steer") {
          expect(JSON.stringify(messages.at(-2))).toContain("Queued extension context.");
        }
        if (initial) {
          expect(messages.at(-2)).toMatchObject({
            role: "user",
            operatorMessage: { turnScoped: true },
          });
        }
        if (continuation === "initial-backlog" || continuation === "steer-backlog") {
          const first = initial ? 0 : 1;
          expect(JSON.stringify(requests[first])).not.toContain("A later queued request.");
          expect(JSON.stringify(requests[first + 1])).toContain("A later queued request.");
        }
      }
    },
  );

  it("rechecks authority after awaiting persistence, before dispatch", async () => {
    const { activeSession } = createSession();
    const stream = vi.fn<StreamFn>();
    activeSession.agent.streamFn = stream;
    const admission = prepareSystemAgentRunAdmission({}, "prompt-restoration", "main", "prompt");
    try {
      const admitted = await admission.admit("embedded");
      await expect(
        submitEmbeddedAttemptPrompt({
          ...createBaseInput(),
          activeSession,
          assertHostActive: resolveAdmittedRunActiveAssertion(admitted),
          persistToolResultProjections: async () => {
            admission.close();
          },
          promptActiveSession: async (_prompt, options) => {
            options?.preflightResult?.(true);
            await activeSession.agent.streamFn(testModel, { messages: [] }, {});
          },
        }),
      ).rejects.toThrow("admitted run authority is no longer active");
      expect(stream).not.toHaveBeenCalled();
    } finally {
      admission.close();
    }
  });
});
