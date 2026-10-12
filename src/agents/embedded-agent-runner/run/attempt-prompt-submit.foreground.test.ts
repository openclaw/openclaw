import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../../../llm/types.js";
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
  beginSessionSystemPrompt,
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
  it("retires a late update canceled after durable append and before its checkpoint", async () => {
    const model = {
      ...testModel,
      provider: "anthropic",
      api: "anthropic-messages" as const,
      id: "claude-opus-5",
    };
    const { session, sessionManager } = await createTestSession({ model });
    const input = createBaseInput();
    const routeKey = "anthropic/claude-opus-5/anthropic-messages";
    const pinnedPrompt = "## Tools\nOnly approved tools are available.";
    const restoredPrompt = "## Tools\nThe canceled tool restoration is available.";
    const prepare = (systemPrompt: string) =>
      prepareSessionSystemPrompt({
        state: input.sessionPromptState,
        routeKey,
        systemPrompt,
        entries: sessionManager.getBranch(),
      });
    const persist = () =>
      persistSessionSystemPrompt(input.sessionPromptState, (customType, data) =>
        sessionManager.appendCustomEntryAsync(customType, data),
      );
    prepare(pinnedPrompt).commit();
    await persist();
    session.setBaseSystemPrompt(pinnedPrompt);
    const append = sessionManager.appendCustomMessageEntryAsync.bind(sessionManager);
    const interruptedAppend = vi
      .spyOn(sessionManager, "appendCustomMessageEntryAsync")
      .mockImplementation(async (...args) => {
        const id = await append(...args);
        if (args[0] === "openclaw.system-update") {
          session.agent.abort(new Error("Canceled after operator persistence"));
        }
        return id;
      });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      prependContext: undefined,
      appendContext: undefined,
      persistToolResultProjections: persist,
      preparePrimaryModelRequest: () => {
        const projection = prepare(restoredPrompt);
        return Promise.resolve(() => ({
          systemPrompt: projection.systemPrompt,
          promptUpdate: { update: projection.update, commit: projection.commit },
        }));
      },
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    interruptedAppend.mockRestore();
    expect(streamMocks.streamSimple).not.toHaveBeenCalled();
    const interruptedBranch = sessionManager.getBranch();
    expect(
      interruptedBranch.filter(
        (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
      ),
    ).toHaveLength(1);
    expect(interruptedBranch).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "openclaw.system-update",
        content: expect.stringContaining("canceled tool restoration"),
      }),
    );

    beginSessionSystemPrompt({
      state: input.sessionPromptState,
      routeKey,
      enabled: true,
      entries: interruptedBranch,
    });
    const recovered = prepare(pinnedPrompt);
    expect(recovered.restart).toBe(true);
    expect(recovered.update).toBeUndefined();
    recovered.commit();
    await persist();
    const resumed = await createTestSession({ model, sessionManager });
    resumed.session.setBaseSystemPrompt(recovered.systemPrompt);
    const convert = resumed.session.agent.convertToLlm;
    resumed.session.agent.convertToLlm = (messages) =>
      convert(normalizeMessagesForLlmBoundary(messages, { inHistorySystemUpdates: true }));
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel, context: Context) => {
      requests.push({ ...context, messages: structuredClone(context.messages) });
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "Recovered." }]),
      );
    });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: resumed.session,
      prependContext: undefined,
      appendContext: undefined,
      persistToolResultProjections: persist,
      promptActiveSession: (prompt, options) => resumed.session.prompt(prompt, options),
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.systemPrompt).toBe(pinnedPrompt);
    expect(JSON.stringify(requests[0])).not.toContain("canceled tool restoration");
    expect(sessionManager.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "openclaw.system-update",
        content: expect.stringContaining("canceled tool restoration"),
      }),
    );
  });

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

  it("retains a late prompt update through a tool round with session-owned history", async () => {
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
    const input = createBaseInput();
    const previous = session.agent.prepareNextTurnWithContext;
    session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const snapshot = await previous?.(turn, signal);
      return {
        ...snapshot,
        context: {
          ...(snapshot?.context ?? turn.context),
          messages: session.agent.state.messages.slice(),
        },
      };
    };
    const pinnedPrompt = "## Tools\nNo tools are selected.";
    session.setBaseSystemPrompt(pinnedPrompt);
    const prepare = (systemPrompt: string) =>
      prepareSessionSystemPrompt({
        state: input.sessionPromptState,
        routeKey: "anthropic/claude-opus-5/anthropic-messages",
        systemPrompt,
        entries: sessionManager.getBranch(),
      });
    const persist = () =>
      persistSessionSystemPrompt(input.sessionPromptState, (customType, data) =>
        sessionManager.appendCustomEntryAsync(customType, data),
      );
    prepare(pinnedPrompt).commit();
    await persist();
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
      expect(
        sessionManager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === "openclaw.system-update",
          ),
      ).toHaveLength(1);
      return createAssistantResultStream(
        createAssistant(
          activeModel,
          requests.length === 1
            ? [{ type: "toolCall", id: "read-fixture", name: "read", arguments: {} }]
            : [{ type: "text", text: "Done." }],
          requests.length === 1 ? "toolUse" : "stop",
        ),
      );
    });
    let restore = true;
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      prependContext: undefined,
      appendContext: undefined,
      persistToolResultProjections: persist,
      preparePrimaryModelRequest: () => {
        if (!restore) {
          return undefined;
        }
        restore = false;
        const projection = prepare("## Tools\nThe read tool is available.");
        return Promise.resolve(() => ({
          tools: session.agent.state.tools,
          systemPrompt: projection.systemPrompt,
          promptUpdate: { update: projection.update, commit: projection.commit },
        }));
      },
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.systemPrompt)).toEqual([pinnedPrompt, pinnedPrompt]);
    expect(requests[0]?.messages.at(-1)).toMatchObject({
      role: "user",
      operatorMessage: { turnScoped: false },
      content: expect.stringContaining("The read tool is available."),
    });
    expect(requests[1]?.messages.slice(0, requests[0]!.messages.length)).toEqual(
      requests[0]?.messages,
    );
    expect(requests[1]?.messages.slice(-2).map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(
      session.messages.filter(
        (message) => message.role === "custom" && message.customType === "openclaw.system-update",
      ),
    ).toHaveLength(1);
  });

  it("observes only foreground dispatch and keeps compaction out of restoration", async () => {
    const { activeSession } = createSession();
    const captures: Context[] = [];
    const stream: StreamFn = (_model, context) => {
      captures.push(context);
      return createAssistantResultStream(createAssistant(testModel, []));
    };
    activeSession.agent.streamFn = stream;
    const restoredTools = [
      { name: "message", description: "required", parameters: { type: "object" as const } },
    ];
    let changed = false;
    const prepare = vi.fn(() =>
      changed
        ? Promise.resolve(() => ({ tools: restoredTools, systemPrompt: "restored" }))
        : undefined,
    );
    const observe = vi.fn();
    await submitEmbeddedAttemptPrompt({
      ...createBaseInput(),
      activeSession,
      onPrimaryModelRequest: observe,
      preparePrimaryModelRequest: prepare,
      promptActiveSession: async (_prompt, options) => {
        const request = (systemPrompt: string) =>
          activeSession.agent.streamFn(testModel, { messages: [], tools: [], systemPrompt }, {});
        await request("preflight");
        expect(observe).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        options?.preflightResult?.(true);
        await request("filtered");
        prepare.mockClear();
        changed = true;
        activeSession.isCompacting = true;
        await request("compaction");
        expect(prepare).not.toHaveBeenCalled();
        activeSession.isCompacting = false;
        await request("filtered");
      },
    });
    expect(captures.map(({ tools, systemPrompt }) => ({ tools, systemPrompt }))).toEqual([
      { tools: [], systemPrompt: "preflight" },
      { tools: [], systemPrompt: "filtered" },
      { tools: [], systemPrompt: "compaction" },
      { tools: restoredTools, systemPrompt: "restored" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledExactlyOnceWith([]);
    expect(activeSession.agent.streamFn).toBe(stream);
  });

  it("rechecks authority after awaiting restoration, before callbacks or dispatch", async () => {
    const { activeSession } = createSession();
    const stream = vi.fn<StreamFn>();
    activeSession.agent.streamFn = stream;
    let active = true;
    const reader = vi.fn(() => ({ tools: [], systemPrompt: "restored" }));
    const observe = vi.fn();
    await expect(
      submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        activeSession,
        onPrimaryModelRequest: observe,
        assertHostActive: () => {
          if (!active) {
            throw new Error("authority closed");
          }
        },
        preparePrimaryModelRequest: async () => {
          active = false;
          return reader;
        },
        promptActiveSession: async (_prompt, options) => {
          options?.preflightResult?.(true);
          await activeSession.agent.streamFn(testModel, { messages: [] }, {});
        },
      }),
    ).rejects.toThrow("authority closed");
    expect(reader).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });
});
