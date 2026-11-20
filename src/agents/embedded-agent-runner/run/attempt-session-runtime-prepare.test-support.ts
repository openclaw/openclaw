import { vi, type Mock } from "vitest";
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
