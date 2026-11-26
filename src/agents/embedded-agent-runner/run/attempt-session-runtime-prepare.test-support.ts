import { onTestFinished, vi, type Mock } from "vitest";
import { memorySessionActorOwners } from "../../../config/sessions/session-actor-memory-owner.js";
import { acquireSessionActorStorage } from "../../../config/sessions/session-actor-storage-acquisition.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  sessionManagerReadToolResultProjectionEntries,
  sessionManagerReadTranscriptBranch,
} from "../../sessions/session-manager-view-types.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";

export type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];

/** The hoisted stage mocks the test file installs with vi.mock for the session preparation seams. */
export type RuntimePrepareMocks = Record<
  | "createAnthropicPayloadLogger"
  | "createCacheTrace"
  | "createSessionSettleTracker"
  | "retainSessionPromptState"
  | "installContextGuards"
  | "prepareAgentSession"
  | "prepareSessionBoundary"
  | "prepareSessionManager"
  | "createTrajectory"
  | "prepareTransport",
  Mock
>;

export function createRuntimePrepareFixture(
  mocks: RuntimePrepareMocks,
  admittedRunContext: PrepareInput["attempt"]["admittedRunContext"],
) {
  const order: string[] = [];
  const activeMarker = { type: "custom", customType: "openclaw.cache-ttl", data: "active" };
  const f = {
    order,
    sessionManager: {
      [sessionManagerReadTranscriptBranch]: () => [activeMarker],
      getBoundaryCount: () => 0,
      [sessionManagerReadToolResultProjectionEntries]: () => [activeMarker],
    },
    activeSession: {
      messages: [{ role: "user" }, { role: "assistant" }],
      sessionId: "active-session",
    },
    promptState: { toolResults: { projected: true } },
    abortActiveSession: vi.fn(async () => undefined),
    buildAbortSettlePromise: vi.fn(() => null),
    contextGuards: { remove: vi.fn() },
    trajectoryRecorder: { kind: "trajectory", recordEvent: vi.fn() },
    transcriptPolicy: { repairToolUseResultPairing: true, inHistorySystemUpdates: false },
    getUserTranscriptContexts: vi.fn(() => []),
    onSessionYieldReady: vi.fn(() => order.push("own-yield")),
    externalAbortController: {
      setActiveSessionAbort: vi.fn(() => order.push("arm-session-abort")),
    },
  };
  const agentSession = {
    activeSession: f.activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt: vi.fn(),
  };
  const promptStateLease = { state: f.promptState, [Symbol.dispose]: vi.fn() };
  const transport = {
    compactionReplayEnabled: true,
    effectivePromptCacheRetention: "long",
  };
  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(f.sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage: { role: "user", content: "hello" },
      sessionManager: f.sessionManager,
      transcriptPolicy: f.transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts: f.getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(f.activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  const stage =
    <T>(name: string, value: T) =>
    () => {
      order.push(name);
      return value;
    };
  mocks.prepareSessionBoundary.mockImplementation(stage("boundary", {}));
  mocks.retainSessionPromptState.mockImplementation(stage("prompt-state", promptStateLease));
  mocks.createSessionSettleTracker.mockImplementation(
    stage("settle-tracker", {
      abortActiveSession: f.abortActiveSession,
      buildAbortSettlePromise: f.buildAbortSettlePromise,
    }),
  );
  mocks.installContextGuards.mockImplementation(stage("context-guards", f.contextGuards));
  mocks.createCacheTrace.mockImplementation(stage("cache-trace", {}));
  mocks.createAnthropicPayloadLogger.mockImplementation(stage("payload-logger", {}));
  mocks.createTrajectory.mockImplementation(async () =>
    stage("trajectory", f.trajectoryRecorder)(),
  );
  mocks.prepareTransport.mockImplementation(async () => stage("transport", transport)());

  const resources = new Proxy<PrepareInput["resources"]>(
    { trajectoryRecorder: null, buildAbortSettlePromise: () => null },
    {
      set: (target, key, value) => {
        order.push(`own-${String(key)}`);
        return Reflect.set(target, key, value);
      },
    },
  );
  const input = {
    attempt: {
      config: {},
      admittedRunContext,
      fastMode: true,
      workspaceDir: "/tmp/workspace",
      sessionFile: "/tmp/session.jsonl",
      sessionKey: "agent:main:session-1",
      model: { api: "openai-responses" },
      modelId: "gpt-5",
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    setup: {
      prepStages: { mark: vi.fn() },
      sessionAgentId: "main",
      effectiveWorkspace: "/tmp/workspace",
    },
    toolBase: {
      agentProfile: {
        profile: { id: "openclaw/base", ancestry: ["openclaw/base"], spec: { common: {} } },
        selectionSource: "fallback",
      },
      codeModeControlsEnabledForRun: false,
    },
    toolCatalog: {
      installToolListingPin: vi.fn(async () => false),
      effectiveTools: [],
      toolSearchRunPlan: { replayAllowedToolNames: new Set(["read"]) },
    },
    bundleTools: { clientTools: [], uncompactedEffectiveTools: [] },
    prepareSystemPrompt: async () => ({ systemPromptText: "initial prompt" }),
    sessionLock: {
      transcriptLifecycle: {},
      ownedTranscriptWriteContext: {
        withTranscriptWrite: async (operation: () => unknown) => await operation(),
      },
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => {
        order.push("owned-boundary");
        return await operation();
      }),
    },
    runAbortSignal: new AbortController().signal,
    externalAbortController: f.externalAbortController,
    resources,
    onSessionYieldReady: f.onSessionYieldReady,
  } as unknown as PrepareInput;

  const prepare = () => prepareEmbeddedAttemptSessionRuntime(input);
  return { ...f, agentSession, input, resources, promptStateLease, prepare };
}

/** One synthetic SQLite-backed incognito session and an admitted run; cleanup is per test. */
export async function openSyntheticSqliteSession(sessionId: string, label: string) {
  const env = { OPENCLAW_STATE_DIR: `/synthetic/${label}/${sessionId}` };
  const scope = {
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:dashboard:incognito-${sessionId}`,
    storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  };
  const admission = prepareSystemAgentRunAdmission({}, `run-${sessionId}`, "main", label);
  onTestFinished(() => admission.close());
  const admittedRunContext = await admission.admit("embedded");
  const authority = { assertCurrent() {}, authorize() {} };
  const binding = await acquireSessionActorStorage(scope, {
    authority,
    lifetime: { assertCurrent() {}, assertReadable() {} },
    create: true,
  });
  if (!binding) {
    throw new Error("Missing incognito fixture actor");
  }
  onTestFinished(async () => {
    await binding.actor.release();
    memorySessionActorOwners.closeDatabase(binding);
  });
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
  return { scope, admittedRunContext };
}
