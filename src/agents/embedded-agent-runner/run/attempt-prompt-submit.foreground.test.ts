import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import type { Context } from "../../../llm/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
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
import { SessionManager } from "../../sessions/session-manager.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
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

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

it("keeps the request prefix when bounded reload omits an existing compaction", async () => {
  const env = { OPENCLAW_STATE_DIR: "/synthetic/prompt-prefix-bounded-reload" };
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:dashboard:incognito-${sessionId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const authority = { assertCurrent() {}, authorize() {} };
  const binding = await acquireSessionActorStorage(scope, {
    authority,
    lifetime: { assertCurrent() {}, assertReadable() {} },
    create: true,
  });
  if (!binding) {
    throw new Error("Missing incognito fixture actor");
  }
  try {
    await binding.actor.storage.mutate(
      {
        type: "session.entry.create",
        input: {
          entry: { sessionId, lifecycleRevision: "initial", updatedAt: 1 },
          cwd: "/synthetic",
        },
      },
      authority,
    );
    const source = await SessionManager.openAsync(scope);
    const retained = await source.appendMessageAsync(makeUserMessage("Earlier turn", 1));
    await source.appendCompactionAsync("Summary. ".repeat(550), retained!, 10_000);
    const input = createBaseInput();
    const pinnedPrompt = "## Skills\nOriginal skills\n## Documentation\nOriginal docs";
    const refreshedPrompt = "## Skills\nUpdated skills\n## Documentation\nUpdated docs";
    const original = prepareSessionSystemPrompt({
      state: input.sessionPromptState,
      routeKey: "fixture",
      systemPrompt: pinnedPrompt,
      entries: source.getBranch(),
    });
    original.commit();
    await persistSessionSystemPrompt(input.sessionPromptState, (kind, data) =>
      source.appendCustomEntryAsync(kind, data),
    );
    const sessionManager = await SessionManager.openBoundedAsync(scope, {
      maxBytes: 8_192,
      maxEvents: 100,
    });
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    const { session } = await createTestSession({
      sessionManager,
      systemPrompt: refreshedPrompt,
      customTools: [
        {
          ...createStubTool("read"),
          execute: async () => ({
            content: [{ type: "text", text: "x".repeat(5_000) }],
            details: {},
          }),
        },
      ],
    });
    const prepareSystemPromptUpdate = () =>
      prepareSessionSystemPrompt({
        state: input.sessionPromptState,
        routeKey: "fixture",
        systemPrompt: refreshedPrompt,
        entries: sessionManager.getBranch(),
        historyBoundaryCount: sessionManager.getBoundaryCount(),
      });
    installAttemptPermissionPrompt({
      activeSession: session,
      attempt: { model: { api: "openai-responses" } },
      runAbortSignal: new AbortController().signal,
      setActiveSessionSystemPrompt: (prompt) => {
        session.setBaseSystemPrompt(prompt);
        return prompt;
      },
      prepareSystemPromptUpdate,
    });
    let reloaded = false;
    session.agent.subscribe(async (event) => {
      if (event.type !== "turn_end" || reloaded) {
        return;
      }
      reloaded = true;
      await sessionManager.reloadPersistedTranscriptAsync();
      expect(sessionManager.getBoundaryCount()).toBe(1);
      expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    });
    const requests: string[] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(context.systemPrompt ?? "");
      const useTool = requests.length === 1;
      return createAssistantResultStream(
        createAssistant(
          model,
          useTool
            ? [{ type: "toolCall", id: "read-fixture", name: "read", arguments: {} }]
            : "Done.",
          useTool ? "toolUse" : "stop",
        ),
      );
    });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      prependContext: undefined,
      appendContext: undefined,
      toolResultMaxChars: 20_000,
      toolResultAggregateMaxChars: 20_000,
      persistToolResultProjections: () =>
        persistSessionSystemPrompt(input.sessionPromptState, (kind, data) =>
          sessionManager.appendCustomEntryAsync(kind, data),
        ),
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    expect(reloaded).toBe(true);
    expect(requests).toEqual([pinnedPrompt, pinnedPrompt]);
  } finally {
    await binding.actor.release();
    memorySessionActorOwners.closeDatabase(binding);
  }
});

it.each(["tool", "steer", "steer-backlog", "cancelled", "initial-backlog", "agent-end"] as const)(
  "refreshes permissions only for admitted %s continuation input",
  async (continuation) => {
    const extension = continuation === "steer";
    const cancelled = continuation === "cancelled";
    const { session, sessionManager } = await createTestSession({
      model: {
        ...testModel,
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-opus-5",
      },
      customTools: [
        {
          ...createStubTool("read"),
          execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
        },
      ],
    });
    if (extension) {
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
    const backlog = initial || continuation === "steer-backlog";
    const enqueue = () => {
      session.agent.steer(queuedUser);
      if (backlog) {
        session.agent.steer({ role: "user", content: "A later queued request.", timestamp: 3 });
      }
    };
    const persistPrompt = () =>
      persistSessionSystemPrompt(input.sessionPromptState, (customType, data) =>
        sessionManager.appendCustomEntryAsync(customType, data),
      );
    if (initial) {
      prepareSystemPromptUpdate(pinnedPrompt).commit();
      await persistPrompt();
      currentPrompt = "## Tools\nread";
      enqueue();
    }
    let finishedTurns = 0;
    let recovered = false;
    session.agent.subscribe(async (event) => {
      if (continuation === "agent-end" && event.type === "agent_end" && !recovered) {
        recovered = true;
        session.agent.steer(queuedUser);
      }
      if (event.type === "message_start" && event.message === queuedUser && cancelled) {
        session.agent.cancelSteeringMessage((message) => message === queuedUser);
      }
      if (event.type !== "turn_end" || ++finishedTurns !== 1) {
        return;
      }
      currentPrompt = "## Tools\nread";
      if (["steer", "steer-backlog", "cancelled"].includes(continuation)) {
        enqueue();
        if (extension) {
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
            : "Done.",
          useTool ? "toolUse" : "stop",
        ),
      );
    });
    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession: session,
      prependContext: undefined,
      appendContext: undefined,
      appendOnlyRuntimeContext: initial,
      runtimeContextMessage: initial
        ? buildRuntimeContextCustomMessage("Runtime at initial admission.", undefined, true)
        : undefined,
      persistToolResultProjections: persistPrompt,
      promptActiveSession: (prompt, options) => session.prompt(prompt, options),
    });
    const updates = sessionManager
      .getBranch()
      .filter(
        (entry) => entry.type === "custom_message" && entry.customType === "openclaw.system-update",
      );
    if (cancelled) {
      expect(requests).toHaveLength(1);
      expect(updates).toHaveLength(0);
    } else {
      const expectedRequests = continuation === "steer-backlog" ? 3 : 2;
      expect(updates).toHaveLength(initial ? 2 : 1);
      expect(requests.map((request) => request.systemPrompt)).toEqual(
        Array.from({ length: expectedRequests }, () => pinnedPrompt),
      );
      const messages = requests[initial ? 0 : backlog ? 1 : expectedRequests - 1]!.messages;
      expect(messages.at(-1)).toMatchObject({
        role: "user",
        operatorMessage: { turnScoped: false },
        content: expect.stringContaining("## Tools\nread"),
      });
      if (continuation === "tool") {
        expect(messages.at(-2)?.role).toBe("toolResult");
      } else {
        expect(JSON.stringify(messages.at(extension || initial ? -3 : -2))).toContain(
          queuedUser.content,
        );
      }
      if (extension) {
        expect(JSON.stringify(messages.at(-2))).toContain("Queued extension context.");
      }
      if (initial) {
        expect(messages.at(-2)).toMatchObject({
          role: "user",
          operatorMessage: { turnScoped: true },
        });
      }
      if (backlog) {
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
