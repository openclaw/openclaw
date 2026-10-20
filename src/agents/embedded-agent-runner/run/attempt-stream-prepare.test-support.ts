import { Type } from "typebox";
import { vi } from "vitest";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { ReplyOperation } from "../../../sessions/session-controller.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  buildToolLifecycleErrorResult,
  prepareToolResult,
} from "../../embedded-agent-tool-results.js";
import { createMediaGenerationOperation } from "../../media-generation-activity.js";
import { resetGeneratedMediaTaskActivityForTests } from "../../media-generation-activity.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../../sessions/agent-session-loop-resource-loader.test-support.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { isToolResultError } from "../../tool-result-error.js";
import { getActiveNativeAttempt } from "../run-state.js";
import {
  createAttemptNestedToolActivityState,
  readAttemptNestedToolActivity,
} from "./attempt-nested-tool-activity.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";

type StreamInput = Parameters<typeof prepareEmbeddedAttemptStream>[0];
const idleRunState = {
  aborted: false,
  promptError: undefined,
  timedOut: false,
  yieldDetected: false,
};

export function prepareCatalogExecutor(options?: {
  diagnosticOwner?: StreamInput["diagnosticOwner"];
  getRunState?: StreamInput["getRunState"];
  runAbortController?: AbortController;
  abortRun?: StreamInput["abortRun"];
  markExternalAbort?: StreamInput["markExternalAbort"];
  recoverStalledModelCall?: StreamInput["recoverStalledModelCall"];
  activeSession?: AgentSession;
  sessionManager?: SessionManager;
  hookRunner?: StreamInput["agentSession"]["hookRunner"];
  attempt?: Partial<StreamInput["attempt"]>;
  sessionKey?: string;
  replyOperation?: ReplyOperation;
  onAttemptAbort?: () => void;
  toolProgressDetail?: "explain" | "raw";
  onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
  streamReplies?: boolean;
}) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  const nestedToolActivityState = createAttemptNestedToolActivityState();
  const activeSession =
    options?.activeSession ??
    ({
      agent: {},
      isStreaming: false,
      sessionManager: options?.sessionManager ?? SessionManager.inMemory(),
      subscribe: () => () => {},
    } as never);
  const prepared = prepareEmbeddedAttemptStream({
    attempt: {
      runId: "run-output-schema",
      sessionId: "session-output-schema",
      sessionKey: options?.sessionKey ?? "agent:main:main",
      replyOperation: options?.replyOperation,
      onAttemptAbort: options?.onAttemptAbort,
      toolProgressDetail: options?.toolProgressDetail,
      onAgentEvent: options?.onAgentEvent,
      ...options?.attempt,
    } as never,
    agentSession: {
      activeSession,
      hookRunner: options?.hookRunner ?? null,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      builtinToolNames: new Set(),
      sourceReplyCapableToolNames: new Set(),
      coreBuiltinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      codeModeExecToolNames: new Set(),
      sideEffectToolOwners: new Map(),
      trustedLocalMediaToolNames: new Set(options?.trustedLocalMediaToolNames),
    },
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner:
      options?.diagnosticOwner ??
      createDiagnosticEmbeddedRunOwner({
        sessionId: "session-output-schema",
        runId: "run-output-schema",
      }),
    nestedToolActivityState,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: options?.abortRun ?? vi.fn(),
    markExternalAbort: options?.markExternalAbort ?? vi.fn(),
    recoverStalledModelCall: options?.recoverStalledModelCall,
    getRunState: options?.getRunState ?? (() => ({ ...idleRunState })),
    onBlockReply: options?.streamReplies === false ? undefined : vi.fn(),
    onBlockReplyFlush: options?.streamReplies === false ? undefined : vi.fn(),
  });
  return {
    ...prepared,
    nestedToolActivityState,
    readActivities: () =>
      readAttemptNestedToolActivity(activeSession.sessionManager, nestedToolActivityState),
  };
}

export function createBeforeFinalizeEvent() {
  return {
    messages: [],
    willRetry: false,
    assistantEntryId: "canonical-entry-id",
    lastAssistant: {
      role: "assistant",
      content: [{ type: "text", text: "Draft answer" }],
      stopReason: "stop",
    },
    assistantTexts: ["Draft answer"],
    hasAssistantVisibleText: true,
    isError: false,
    incompleteTerminalAssistant: false,
    hadDeterministicSideEffect: false,
    hasPendingContinuation: false,
  };
}

export async function createHeldSettlementSession() {
  const settled = createDeferredCore();
  const releaseSettlement = createDeferredCore();
  const holdSettlement = async () => {
    settled.resolve();
    await releaseSettlement.promise;
  };
  const { session } = await createTestSession({
    resourceLoader: await createResourceLoader((api) => {
      api.on("agent_settled", holdSettlement);
    }),
  });
  streamMocks.streamSimple.mockImplementation((model) =>
    createAssistantResultStream(createAssistant(model, "Done.")),
  );
  return { session, settled, releaseSettlement };
}

export async function createTurnHandoffSession() {
  const { session } = await createTestSession({
    customTools: [
      {
        name: "handoff",
        label: "Handoff",
        description: "Hand off the current turn",
        parameters: Type.Object({}),
        execute: async () => {
          activeSession.agent.abort({ code: "turn_handoff", turnHandoff: true });
          return { content: [{ type: "text", text: "Handed off." }], details: {} };
        },
      },
    ],
  });
  const activeSession = session;
  streamMocks.streamSimple.mockImplementation((model) =>
    createAssistantResultStream(
      createAssistant(
        model,
        [{ type: "toolCall", id: "handoff-call", name: "handoff", arguments: {} }],
        "toolUse",
      ),
    ),
  );
  return session;
}

export async function trackPreparedStreamSubscriptions(
  setSubscribe: (
    subscribe: typeof import("../../embedded-agent-subscribe.js").subscribeEmbeddedAgentSession,
  ) => void,
) {
  const { session } = await createTestSession();
  const listeners = new Set<Parameters<AgentSession["subscribe"]>[0]>();
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const subscribe = session.subscribe.bind(session);
  vi.spyOn(session, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    const unsubscribe = subscribe(listener);
    const release = vi.fn(() => {
      listeners.delete(listener);
      unsubscribe();
    });
    releases.push(release);
    return release;
  });
  const actual = await vi.importActual<typeof import("../../embedded-agent-subscribe.js")>(
    "../../embedded-agent-subscribe.js",
  );
  setSubscribe(actual.subscribeEmbeddedAgentSession);
  return { session, listeners, releases };
}

export function createCatalogSubscription() {
  return {
    unsubscribe: vi.fn(),
    toolMetas: [],
    runToolLifecycle: vi.fn(async ({ args, execute, onTerminal }) => {
      const terminal = (result: Parameters<typeof prepareToolResult>[0], isError: boolean) =>
        onTerminal?.({
          result,
          readSanitizedResult: prepareToolResult(result),
          isError,
          executedArguments: structuredClone(args),
          effectReceipt: { state: "uncertain" },
        });
      try {
        const result = await execute(() => undefined);
        await terminal(result, isToolResultError(result));
        return result;
      } catch (error) {
        await terminal(buildToolLifecycleErrorResult(error), true);
        throw error;
      }
    }),
    isCompacting: vi.fn(() => false),
  };
}

export async function observeTerminalRunActivity(
  scenario: "ordinary" | "cancelled" | "deferred cancellation" | "pending task",
  setSubscribe: Parameters<typeof trackPreparedStreamSubscriptions>[0],
) {
  resetGeneratedMediaTaskActivityForTests();
  try {
    const { session, listeners } = await trackPreparedStreamSubscriptions(setSubscribe);
    const sessionKey = "agent:main:cron:terminal-ownership:run:run-output-schema";
    const cancelled = scenario === "cancelled" || scenario === "deferred cancellation";
    const deferred = scenario === "deferred cancellation";
    const runAbortController = new AbortController();
    if (cancelled) {
      runAbortController.abort();
    }
    if (scenario === "pending task") {
      createMediaGenerationOperation({
        taskId: "tool:image_generate:terminal",
        status: "running",
        createdAt: 1,
        taskKind: "image_generation",
        requesterSessionKey: sessionKey,
        runId: "tool:image_generate:terminal",
      });
    }
    const terminalEvents: Array<{ phase: unknown; active: boolean }> = [];
    const prepared = prepareCatalogExecutor({
      activeSession: session,
      sessionKey,
      runAbortController,
      getRunState: () => ({ ...idleRunState, aborted: cancelled }),
      attempt: deferred
        ? { deferTerminalLifecycle: true, onDeferredLifecycleOwner: () => {} }
        : undefined,
      onAgentEvent: (event) => {
        if (event.stream === "lifecycle") {
          terminalEvents.push({
            phase: event.data.phase,
            active: Boolean(getActiveNativeAttempt("session-output-schema")),
          });
        }
      },
    });
    try {
      const activeBefore = getActiveNativeAttempt("session-output-schema") === prepared.queueHandle;
      for (const listener of listeners) {
        await listener({ type: "agent_end", messages: [], willRetry: false });
      }
      await prepared.subscription.waitForPendingEvents();
      return {
        activeBefore,
        terminalEvents,
        activeAfter: Boolean(getActiveNativeAttempt("session-output-schema")),
      };
    } finally {
      try {
        await prepared.subscription.waitForPendingEvents();
      } finally {
        await prepared.deferredLifecycleOwner?.discard();
        prepared.subscription.unsubscribe();
        const { detachActiveEmbeddedRun } =
          await vi.importActual<typeof import("../runs.js")>("../runs.js");
        detachActiveEmbeddedRun("session-output-schema", prepared.queueHandle, sessionKey);
      }
    }
  } finally {
    resetGeneratedMediaTaskActivityForTests();
  }
}
