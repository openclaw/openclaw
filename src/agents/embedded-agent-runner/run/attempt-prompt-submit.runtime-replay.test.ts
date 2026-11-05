import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { Context } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
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
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history-prepare.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, sessionId } from "./attempt-prompt-submit.test-support.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

registerAgentSessionLoopTestLifecycle();

afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));
const provider = { id: "fixture", label: "Fixture", auth: [] };

it.each([
  ["openai-completions", false],
  ["anthropic-messages", false],
  ["google-generative-ai", false],
  ["openai-completions", true],
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
        if (api !== "google-generative-ai") {
          expect(request.filter((message) => message.role === "user")).toHaveLength(
            request === requests[2] ? 2 : 1,
          );
        }
      }
      const prefix = (messages: Context["messages"]) =>
        messages.map(({ role, content }) => ({ role, content }));
      expect(prefix(requests[1]!)).toEqual(prefix(requests[0]!));
      expect(prefix(requests[2]!.slice(0, requests[0]!.length))).toEqual(prefix(requests[0]!));
    });
  },
);

it.each([
  { name: "transient override", api: "openai-completions", override: false, retained: false },
  { name: "retained override", api: "openai-completions", override: true, retained: true },
  { name: "generic completions", api: "openai-completions", retained: true },
  { name: "native Ollama", api: "ollama", retained: true },
  {
    name: "suppress-only synthetic input",
    api: "openai-completions",
    retained: true,
    suppressOnly: true,
  },
])(
  "preserves hidden runtime input across provider retry and cold session reopen: $name",
  async ({ api, override, retained, suppressOnly = false }) => {
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
