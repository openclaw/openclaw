import path from "node:path";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import type { Context } from "../../../llm/types.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-input.types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import {
  clearEmbeddedSessionPromptStates,
  prepareSessionSystemPrompt,
  persistSessionSystemPrompt,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { installAttemptPermissionPrompt } from "./attempt-permission-prompt.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, createSession, sessionId } from "./attempt-prompt-submit.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
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

describe("provider retry and cold history", () => {
  const provider = { id: "fixture", label: "Fixture", auth: [] };
  it.each([
    ["openai-completions", true],
    ["anthropic-messages", false],
  ] as const)(
    "keeps an unanswered user across an error-row retry: %s (unsupported projection: %s)",
    async (api, unsupportedProjection) => {
      await withOpenClawTestState({ label: "orphan-provider-retry" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:orphan-provider-retry",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const seed = await SessionManager.openAsync(target, state.workspaceDir);
        const orphan: PersistedUserTurnMessage = {
          role: "user",
          content: "ORPHAN: remember CEDAR",
          timestamp: 1_717_570_800_000,
          idempotencyKey: "orphan:user",
          ...(unsupportedProjection
            ? { __openclaw: { modelPromptProjection: { version: 99, text: "unreadable hint" } } }
            : {}),
        };
        await seed.appendMessageAsync(orphan);
        const model = { ...testModel, api };
        const policy = {
          ...resolveTranscriptPolicy({ modelApi: api }),
          appendOnlyRuntimeContext: false,
          inHistorySystemUpdates: false,
        };
        const requests: Context["messages"][] = [];
        streamMocks.streamSimple.mockImplementation((activeModel, context) => {
          requests.push(structuredClone(context.messages));
          return createAssistantResultStream({
            ...createAssistant(
              activeModel,
              requests.length === 1 ? [] : "done",
              requests.length === 1 ? "error" : "stop",
            ),
            ...(requests.length === 1 ? { errorMessage: "429 synthetic rate limit" } : {}),
          });
        });
        const recorderFor = (text: string, timestamp: number, idempotencyKey: string) =>
          createUserTurnTranscriptRecorder({
            input: { text, timestamp, idempotencyKey },
            target: { ...target, sessionEntry: undefined },
          });
        const repairingTurn = recorderFor(
          "CURRENT: what is the codeword?",
          1_717_570_860_000,
          "current:user",
        );
        for (const stage of ["initial", "retry", "next"] as const) {
          const text = stage === "next" ? "NEXT: keep going" : "CURRENT: what is the codeword?";
          const recorder =
            stage === "next" ? recorderFor(text, 1_717_570_920_000, "next:user") : repairingTurn;
          const contexts = createUserTranscriptContextRegistry();
          const manager = guardSessionManager(
            await SessionManager.openAsync(target, state.workspaceDir),
            {
              preparedUserTurnMessage: recorder.message,
              preparedUserTurnTranscriptRecorder: recorder,
              suppressNextUserMessagePersistence: recorder.hasPersisted(),
              onUserMessagePersisted: (message, runtimeMessage) => {
                if (runtimeMessage) {
                  contexts.record(runtimeMessage, message);
                }
              },
            },
          );
          const { session, settingsManager } = await createTestSession({
            sessionManager: manager,
            model,
          });
          const boundary = await prepareEmbeddedAttemptSessionBoundary({
            activeSession: session,
            appendOnlyRuntimeContext: false,
            attempt: {
              sessionId,
              prompt: text,
              userTurnTranscriptRecorder: recorder,
              config: { agents: { defaults: { userTimezone: "UTC" } } },
            },
            getUserTranscriptContexts: () => contexts.list(),
            isRawModelRun: false,
            preparedUserTurnMessage: recorder.message,
            sessionManager: manager,
            setActiveSessionSystemPrompt: vi.fn(),
          });
          expect(boundary.orphanRepair).toBeUndefined();
          const baseInput = createBaseInput();
          await prepareEmbeddedAttemptHistory(
            {
              attempt: { sessionId, model, modelId: model.id, prompt: text },
              isRawModelRun: false,
              prepared: {
                sessionRuntime: {
                  agentSession: {
                    activeSession: session,
                    settingsManager,
                    setActiveSessionSystemPrompt: (prompt: string) =>
                      session.setBaseSystemPrompt(prompt),
                  },
                  boundary,
                  sessionManager: manager,
                  toolResultPromptProjectionState: baseInput.toolResultPromptProjectionState,
                  transcriptPolicy: policy,
                  transport: { compactionReplayEnabled: false },
                  state: { systemPromptText: "Test session prompt" },
                  isOpenAIResponsesApi: false,
                },
                toolCatalog: {
                  toolSearchRunPlan: {
                    capabilityToolNames: new Set(),
                    replayAllowedToolNames: new Set(),
                  },
                },
              },
              setup: {
                sessionAgentId: "main",
                effectiveWorkspace: state.workspaceDir,
                prepStages: createStageTimingTracker(() => 0),
              },
            } as Parameters<typeof prepareEmbeddedAttemptHistory>[0],
            () => {},
          );
          session.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
            session.agent.streamFn,
            undefined,
            policy,
          );
          await submitEmbeddedAttemptPrompt({
            ...baseInput,
            attempt: { sessionId, userTurnTranscriptRecorder: recorder },
            activeSession: session,
            transcriptPrompt: text,
            modelPrompt: text,
            prependContext: undefined,
            appendContext: undefined,
            getUserTranscriptContexts: () => contexts.list(),
            promptActiveSession: (prompt, options) =>
              session.prompt(prompt, { ...options, expandPromptTemplates: false }),
          });
          expect(recorder.hasPersisted()).toBe(true);
          if (stage === "initial") {
            expect(manager.getLeafEntry()).toMatchObject({
              type: "message",
              message: { role: "assistant", stopReason: "error" },
            });
          }
          session.dispose();
        }
        expect(requests).toHaveLength(3);
        expect(JSON.stringify(requests[1]).match(/ORPHAN: remember CEDAR/g)).toHaveLength(1);
        for (const request of requests) {
          const serialized = JSON.stringify(request);
          expect(serialized.match(/ORPHAN: remember CEDAR/g)).toHaveLength(1);
          expect(serialized.match(/CURRENT: what is the codeword\?/g)).toHaveLength(1);
          expect(serialized).toContain("2024-06-05 07:00");
          expect(serialized).toContain("2024-06-05 07:01");
          expect(request.filter((message) => message.role === "user")).toHaveLength(
            request === requests[2] ? 2 : 1,
          );
        }
        const prefix = (messages: Context["messages"]) =>
          messages.map(({ role, content }) => ({ role, content }));
        expect(prefix(requests[1]!)).toEqual(prefix(requests[0]!));
        expect(prefix(requests[2]!.slice(0, requests[0]!.length))).toEqual(prefix(requests[0]!));
      });
    },
  );
  it.each([
    {
      name: "transient override",
      suppressOnly: false,
      api: "openai-completions",
      override: false,
      retained: false,
    },
    {
      name: "retained override",
      suppressOnly: false,
      api: "openai-completions",
      override: true,
      retained: true,
    },
  ])(
    "preserves hidden runtime input across provider retry and cold session reopen: $name",
    async ({ api, override, retained, suppressOnly }) => {
      const { appendOnlyRuntimeContext } = resolveTranscriptPolicy({
        modelApi: api,
        runtimeHandle: {
          provider: "fixture",
          plugin: {
            ...provider,
            buildReplayPolicy:
              override === undefined ? undefined : () => ({ appendOnlyRuntimeContext: override }),
          },
        },
      });
      await withOpenClawTestState({ label: "runtime-context-persistence" }, async (state) => {
        const target = {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:runtime-context-persistence",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
        });
        const requests: Context["messages"][] = [];
        streamMocks.streamSimple.mockImplementation((model, context) => {
          requests.push(structuredClone(context.messages));
          return createAssistantResultStream(
            requests.length === 1
              ? { ...createAssistant(model, [], "error"), errorMessage: "503 overloaded" }
              : createAssistant(model, "done"),
          );
        });
        const createPersistedSession = async (suppressInput = false) => {
          const sessionManager = guardSessionManager(
            SessionManager.open(target, state.workspaceDir),
            {
              suppressNextUserMessagePersistence: suppressInput,
            },
          );
          const { session } = await createTestSession({ sessionManager, settingsManager });
          await prepareEmbeddedAttemptSessionBoundary({
            activeSession: session,
            appendOnlyRuntimeContext,
            attempt: {
              sessionId,
              prompt: "",
              config: { agents: { defaults: { userTimezone: "UTC" } } },
            },
            getUserTranscriptContexts: () => undefined,
            isRawModelRun: false,
            preparedUserTurnMessage: undefined,
            sessionManager,
            setActiveSessionSystemPrompt: vi.fn(),
          });
          const submit = (text: string, runtimeOnly = false, suppressPrompt = false) => {
            const baseInput = createBaseInput();
            return submitEmbeddedAttemptPrompt({
              ...baseInput,
              attempt: { ...baseInput.attempt, suppressNextUserMessagePersistence: suppressPrompt },
              activeSession: session,
              appendOnlyRuntimeContext,
              runtimeOnly,
              setNextUserMessagePersistence: sessionManager.setNextUserMessagePersistence,
              appendContext: undefined,
              prependContext: undefined,
              transcriptPrompt: text,
              modelPrompt: text,
              runtimeContextMessage: buildRuntimeContextCustomMessage(`context for ${text}`),
              promptActiveSession: (prompt, options) =>
                session.prompt(prompt, { ...options, expandPromptTemplates: false }),
            });
          };
          return { session, sessionManager, submit };
        };
        const first = await createPersistedSession(suppressOnly);
        if (retained) {
          await first.session.sendCustomMessage(
            { customType: "test.extension-context", content: "extension context", display: false },
            { deliverAs: "nextTurn" },
          );
        }
        await first.submit(RUNTIME_EVENT_USER_PROMPT, !suppressOnly, suppressOnly);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(requests[0]).toContainEqual(
          expect.objectContaining({
            role: "user",
            content: expect.stringMatching(/^\[.+\] Continue the OpenClaw runtime event\.$/),
          }),
        );
        first.session.dispose();

        const reopened = await createPersistedSession();
        await reopened.submit("second");
        expect(requests).toHaveLength(3);
        if (retained) {
          // Boundary timestamp text and content before retained responses must replay byte-for-byte.
          const providerPrefix = (messages: Context["messages"]) =>
            JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
          expect(providerPrefix(requests[2]!.slice(0, requests[0]!.length))).toBe(
            providerPrefix(requests[0]!),
          );
        }
        const entries = reopened.sessionManager.getEntries();
        const users = entries.flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message] : [],
        );
        expect(users).toMatchObject([
          {
            content: [{ type: "text", text: RUNTIME_EVENT_USER_PROMPT }],
            display: false,
            provenance: { kind: "internal_system" },
          },
          { content: [{ type: "text", text: "second" }] },
        ]);
        expect(users[1]).not.toHaveProperty("display", false);
        expect(users[1]).not.toHaveProperty("provenance");
        const carriers = entries.filter(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "openclaw.runtime-context",
        );
        expect(carriers).toHaveLength(retained ? 2 : 0);
        if (retained) {
          for (const carrier of carriers) {
            expect(carrier).toMatchObject({ display: false });
            const previous = entries[entries.indexOf(carrier) - 1];
            expect(previous).toMatchObject({ type: "message", message: { role: "user" } });
          }
          expect(requests[0]![1]).toMatchObject({ role: "user", runtimeContext: {} });
        } else {
          expect(JSON.stringify(requests[2])).not.toContain(
            `context for ${RUNTIME_EVENT_USER_PROMPT}`,
          );
        }

        reopened.sessionManager.appendResetBoundary("new");
        const reset = await createPersistedSession();
        await reset.submit("after reset");
        expect(JSON.stringify(requests.at(-1))).not.toContain(RUNTIME_EVENT_USER_PROMPT);
        expect(JSON.stringify(requests.at(-1))).not.toContain("context for second");
        expect(JSON.stringify(requests.at(-1))).toContain("context for after reset");
      });
    },
  );
});
