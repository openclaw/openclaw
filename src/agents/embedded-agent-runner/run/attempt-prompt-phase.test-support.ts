import { vi } from "vitest";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type {
  runEmbeddedAttemptPromptPhase,
  EmbeddedAttemptPromptState,
} from "./attempt-prompt-phase.js";
import type { prepareEmbeddedAttemptPromptPreflight } from "./attempt-prompt-preflight.js";
import type { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

const mocks = vi.hoisted(() => ({
  applyPromptToolsAllow: vi.fn(),
  beforeAgentRun: vi.fn(),
  handlePromptError: vi.fn(),
  handleMidTurnPrecheck: vi.fn(),
  observePrompt: vi.fn(),
  prepareGooglePromptCache: vi.fn(),
  preparePromptAssembly: vi.fn(),
  preparePromptContext: vi.fn(),
  preparePromptExecution: vi.fn(),
  preparePromptPreflight: vi.fn(),
  releasePendingSteering: vi.fn(),
  removeTrailingPrecheckError: vi.fn(),
  resolveApiKey: vi.fn(),
  submitPrompt: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  releasePendingAgentSteeringItems: mocks.releasePendingSteering,
  ackPendingAgentSteeringItems: vi.fn(),
}));
vi.mock("../google-prompt-cache.js", () => ({
  prepareGooglePromptCacheStreamFn: mocks.prepareGooglePromptCache,
}));
vi.mock("../logger.js", () => ({
  log: { debug: mocks.debug, warn: mocks.warn },
}));
vi.mock("../stream-resolution.js", () => ({
  resolveEmbeddedAgentApiKey() {
    return mocks.resolveApiKey();
  },
}));
vi.mock("./attempt-before-agent-run.js", () => ({
  runEmbeddedAttemptBeforeAgentRun: mocks.beforeAgentRun,
}));
vi.mock("./attempt-prompt-build.js", () => ({
  prepareEmbeddedAttemptPromptAssembly: mocks.preparePromptAssembly,
  prepareEmbeddedAttemptPromptContext: mocks.preparePromptContext,
}));
vi.mock("./attempt-prompt-submit.js", () => ({
  handleEmbeddedAttemptPromptError: mocks.handlePromptError,
  submitEmbeddedAttemptPrompt: mocks.submitPrompt,
}));
vi.mock("./prompt-image-preparation.js", () => ({
  prepareEmbeddedAttemptPromptExecution: mocks.preparePromptExecution,
}));
vi.mock("./attempt-prompt-preflight.js", () => ({
  handleEmbeddedAttemptMidTurnPrecheck: mocks.handleMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight: mocks.preparePromptPreflight,
}));
vi.mock("./attempt-prompt-support.js", () => ({
  applyPromptBuildToolsAllow: mocks.applyPromptToolsAllow,
  observeEmbeddedAttemptPrompt: mocks.observePrompt,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  removeTrailingMidTurnPrecheckAssistantError: mocks.removeTrailingPrecheckError,
}));

export { mocks };

type PromptPhaseInput = Parameters<typeof runEmbeddedAttemptPromptPhase>[0];
type AssemblyCall = {
  applyPromptBuildToolsAllow: (toolsAllow: string[] | undefined) => string[];
  setLeasedSteering: (lease: { leaseId: string; runIds: string[] }) => void;
};
export type PromptPreflightCall = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0];
export type PromptSubmissionCall = Parameters<typeof submitEmbeddedAttemptPrompt>[0];

export function createFixture({ pendingPrompt = "hello", pendingImageCount = 1 } = {}) {
  const order: string[] = [];
  const promptState: EmbeddedAttemptPromptState = {
    contextBudgetStatus: undefined,
    preflightRecovery: undefined,
    yieldAborted: false,
  };
  const executionState: PromptPhaseInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const yieldState = {
    yieldAbortSettled: null as Promise<void> | null,
    yieldDetected: false,
    yieldMessage: null as string | null,
  };
  const activeSession = {
    messages: [],
    agent: {
      state: { messages: [] },
      streamFn: vi.fn(),
    },
  };
  const sessionManager = {
    getSessionTarget: () => undefined,
    getHeader: () => ({ version: 3 }),
    appendCustomEntry: vi.fn(),
    getEntries: vi.fn(() => []),
  };
  const sessionRuntimeState = { systemPromptText: "system", prePromptMessageCount: 1 };
  const stopAcceptingSteerMessages = vi.fn(() => {
    order.push("stop-steering");
  });

  mocks.preparePromptAssembly.mockImplementation(async (input: AssemblyCall) => {
    order.push("assembly");
    const lease = { leaseId: "lease-1", runIds: ["run-1"], isCurrent: () => true };
    input.applyPromptBuildToolsAllow(undefined);
    input.setLeasedSteering(lease);
    return {
      hookCtx: {},
      leasedSteering: lease,
      transcriptLeafId: "leaf-1",
    };
  });
  mocks.preparePromptContext.mockImplementation(() => {
    order.push("context");
    return {
      aggregatePressureEngaged: false,
      contextTokenBudget: 32_000,
      currentUserTimestampOverride: { timestamp: 123, text: "hello" },
      effectivePrompt: "hello",
      hookMessagesForCurrentPrompt: [],
      llmBoundaryPromptForPrecheck: pendingPrompt,
      prePromptMessageCount: 2,
      promptForModel: "hello",
      promptForSession: "hello",
      promptSubmission: { prompt: "hello", runtimeOnly: false },
      promptToolResultAggregateMaxChars: 2_000,
      promptToolResultMaxChars: 1_000,
      runtimeContextMessageForCurrentTurn: { role: "custom", content: "runtime" },
      systemPromptForHook: "system",
    };
  });
  mocks.beforeAgentRun.mockImplementation(async () => {
    order.push("before-agent-run");
    return undefined;
  });
  mocks.resolveApiKey.mockResolvedValue("test-key");
  mocks.prepareGooglePromptCache.mockImplementation(async () => {
    order.push("google-cache");
    return undefined;
  });
  mocks.preparePromptExecution.mockImplementation(async () => {
    order.push("images");
    return {
      images: Array.from({ length: pendingImageCount }, () => ({
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      })),
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    };
  });
  mocks.observePrompt.mockImplementation(() => {
    order.push("observe");
    return { skipPromptSubmission: false };
  });
  mocks.preparePromptPreflight.mockImplementation(async (preflightInput: PromptPreflightCall) => {
    order.push("preflight");
    return preflightInput.state;
  });
  mocks.submitPrompt.mockImplementation(async (submissionInput: PromptSubmissionCall) => {
    order.push("submit");
    submissionInput.onFinalPromptText("hello");
    submissionInput.onSteeringAcknowledged();
  });
  mocks.handlePromptError.mockResolvedValue({});
  const input = {
    attempt: {
      model: { id: "model-1", provider: "test" },
      modelId: "model-1",
      provider: "test",
      runId: "run-1",
      sessionId: "session-1",
    },
    isRawModelRun: false,
    runAbortController: new AbortController(),
    state: executionState,
    sessionLock: {
      withOwnedTranscriptWrite: async <T>(operation: () => Promise<T> | T) => await operation(),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    prepared: {
      sessionRuntime: {
        agentSession: {
          activeSession,
          hookRunner: null,
          setActiveSessionSystemPrompt: vi.fn(),
          settingsManager: { getCompactionReserveTokens: () => 77 },
        },
        boundary: {
          includeBoundaryTimestamp: false,
          setCurrentUserTimestampOverride: vi.fn(),
        },
        cacheTrace: null,
        contextGuards: { takePendingMidTurnPrecheckRequest: () => undefined },
        preparedUserTurnMessage: {
          role: "user",
          content: "hello",
          timestamp: 100,
          __openclaw: { senderName: "Alice" },
        },
        sessionManager,
        sessionPromptState: {},
        state: sessionRuntimeState,
        toolResultPromptProjectionState: {},
        trajectoryRecorder: null,
        transcriptPolicy: { appendOnlyRuntimeContext: true },
        transport: {
          effectiveAgentTransport: "sse",
          effectiveExtraParams: {},
          streamStrategy: "default",
          compactionReplayEnabled: false,
        },
      },
      systemPrompt: { runtimeInfo: { model: "model-1" } },
      toolCatalog: {
        toolSearch: { compacted: false },
        toolSearchRunPlan: { capabilityToolNames: new Set(["read"]) },
      },
      promptToolPolicy: {
        current: {
          activeToolNames: ["read"],
          effectiveTools: [{ name: "read" }],
          uncompactedEffectiveTools: [{ name: "read" }],
          tools: [{ name: "read" }],
        },
        apply(toolsAllow: string[] | undefined) {
          Object.assign(this.current, mocks.applyPromptToolsAllow({ toolsAllow }));
          return this.current;
        },
        refresh: vi.fn(),
      },
    },
    preparedStreamRuntime: {
      cache: {},
      history: {
        contextEngineAssemblySucceeded: false,
        contextEnginePromptAuthority: "assembled",
      },
      promptActiveSession: vi.fn(),
      stream: { stopAcceptingSteerMessages },
    },
    lifecycle: { readYieldState: () => yieldState },
  } as unknown as PromptPhaseInput;

  return {
    input,
    order,
    promptState,
    sessionRuntimeState,
    readState: () => ({
      ...promptState,
      ...projectAgentRunAttemptTerminal(executionState.terminal),
    }),
    yieldState,
  };
}
