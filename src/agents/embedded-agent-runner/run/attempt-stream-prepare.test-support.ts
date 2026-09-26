import { Type } from "typebox";
import { vi } from "vitest";
import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { buildToolLifecycleErrorResult } from "../../embedded-agent-tool-results.js";
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
import { ACTIVE_EMBEDDED_RUNS } from "../run-state.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";

export function prepareCatalogExecutor(
  projections: NestedToolActivity[],
  options?: {
    activeSession?: AgentSession;
    hookRunner?: Parameters<typeof prepareEmbeddedAttemptStream>[0]["agentSession"]["hookRunner"];
    attempt?: Partial<Parameters<typeof prepareEmbeddedAttemptStream>[0]["attempt"]>;
    getRunState?: () => {
      aborted: boolean;
      promptError: unknown;
      timedOut: boolean;
      yieldDetected: boolean;
    };
    runAbortController?: AbortController;
    sandboxSessionKey?: string;
    sessionKey?: string;
    replyOperation?: ReplyOperation;
    onAttemptAbort?: () => void;
    abortRun?: (isTimeout?: boolean, reason?: unknown) => void;
    markExternalAbort?: () => void;
    toolProgressDetail?: "explain" | "raw";
    onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
    trustedLocalMediaToolNames?: ReadonlySet<string>;
  },
) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  return prepareEmbeddedAttemptStream({
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
      activeSession:
        options?.activeSession ??
        ({
          agent: {},
          isStreaming: false,
          sessionManager: SessionManager.inMemory(),
          subscribe: () => () => {},
        } as never),
      hookRunner: options?.hookRunner ?? null,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      builtinToolNames: new Set(),
      coreBuiltinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      codeModeExecToolNames: new Set(),
      sideEffectToolOwners: new Map(),
      trustedLocalMediaToolNames: new Set(options?.trustedLocalMediaToolNames),
    },
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({
      sessionId: "session-output-schema",
      runId: "run-output-schema",
    }),
    nestedToolActivities: projections,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: options?.abortRun ?? vi.fn(),
    markExternalAbort: options?.markExternalAbort ?? vi.fn(),
    getRunState:
      options?.getRunState ??
      (() => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      })),
    onBlockReply: vi.fn(),
    onBlockReplyFlush: vi.fn(),
  });
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
    resourceLoader: createResourceLoader(new Map([["agent_settled", [holdSettlement]]])),
  });
  streamMocks.streamSimple.mockImplementation((model) =>
    createAssistantResultStream(createAssistant(model, [{ type: "text", text: "Done." }])),
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
      try {
        const result = await execute(() => undefined);
        await onTerminal?.({
          result,
          isError: isToolResultError(result),
          executedArguments: structuredClone(args),
          effectReceipt: { state: "uncertain" },
        });
        return result;
      } catch (error) {
        await onTerminal?.({
          result: buildToolLifecycleErrorResult(error),
          isError: true,
          executedArguments: structuredClone(args),
          effectReceipt: { state: "uncertain" },
        });
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
        sourceId: "image_generate:terminal",
        requesterSessionKey: sessionKey,
        runId: "tool:image_generate:terminal",
        task: "finish image before releasing run",
        startedAt: 1,
        lastEventAt: 1,
      });
    }
    const terminalEvents: Array<{ phase: unknown; active: boolean }> = [];
    const prepared = prepareCatalogExecutor([], {
      activeSession: session,
      sessionKey,
      runAbortController,
      getRunState: () => ({
        aborted: cancelled,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      attempt: deferred
        ? { deferTerminalLifecycle: true, onDeferredLifecycleOwner: () => {} }
        : undefined,
      onAgentEvent: (event) => {
        if (event.stream === "lifecycle") {
          terminalEvents.push({
            phase: event.data.phase,
            active: ACTIVE_EMBEDDED_RUNS.has("session-output-schema"),
          });
        }
      },
    });
    try {
      const activeBefore =
        ACTIVE_EMBEDDED_RUNS.get("session-output-schema") === prepared.queueHandle;
      for (const listener of listeners) {
        await listener({ type: "agent_end", messages: [], willRetry: false });
      }
      await prepared.subscription.waitForPendingEvents();
      return {
        activeBefore,
        terminalEvents,
        activeAfter: ACTIVE_EMBEDDED_RUNS.has("session-output-schema"),
      };
    } finally {
      try {
        await prepared.subscription.waitForPendingEvents();
      } finally {
        prepared.deferredLifecycleOwner?.discard();
        prepared.subscription.unsubscribe();
        const { clearActiveEmbeddedRun } =
          await vi.importActual<typeof import("../runs.js")>("../runs.js");
        clearActiveEmbeddedRun("session-output-schema", prepared.queueHandle, sessionKey);
      }
    }
  } finally {
    resetGeneratedMediaTaskActivityForTests();
  }
}
