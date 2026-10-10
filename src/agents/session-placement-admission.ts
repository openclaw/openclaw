import { AsyncLocalStorage } from "node:async_hooks";
import { registerReplyOperationSuccessorBarrier } from "../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../config/config.js";
import { assertRequiredWorkerLocalExecution } from "../config/required-worker-profile.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import { retainQueuedAgentRunContext } from "../infra/agent-run-registry.js";
import { enqueueCommandInLane, isCommandLaneTaskMarkerCurrent } from "../process/command-queue.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveAdmittedRunActiveAssertion } from "./admitted-run-context.js";
import { resolveSessionLane } from "./embedded-agent-runner/lanes.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import { resolveEmbeddedRunSessionLanePolicy } from "./embedded-agent-runner/run/lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { settleRequesterRun } from "./requester-run-settlement.js";
import { createSessionPlacementSettlementClosedAbortError } from "./run-termination.js";
import type { SandboxContext } from "./sandbox/types.js";
import { beginForegroundSessionMaintenance } from "./session-maintenance/coordinator.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
  withoutSessionPlacementForcedTerminalSettlement,
} from "./session-placement-forced-terminal-settlement.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

export type SessionPlacementTurnParams = RunEmbeddedAgentInternalParams & { sessionFile: string };

export type SessionPlacementSandboxParams = {
  agentId: string;
  config?: OpenClawConfig;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
};

export type PreparedSessionPlacementSandbox = Disposable & {
  sandbox: SandboxContext | null;
  assertCurrent: () => void;
};

export type SessionPlacementAdmissionProvider = {
  withRequiredSession?: <T>(
    identity: Omit<LocalTurnPlacementClaim, "runId">,
    task: (assertPlacementCurrent: () => void) => Promise<T>,
    assertCurrent?: () => void,
    signal?: AbortSignal,
    preparation?: { waitForReady: false },
  ) => Promise<T>;
  usesWorkerInference?: (identity: Omit<LocalTurnPlacementClaim, "runId">) => boolean;
  resolveRuntimeOverride?: (
    identity: Omit<LocalTurnPlacementClaim, "runId">,
  ) => Promise<string | undefined>;
  assertCompactionSuccessorAllowed: (params: {
    currentTarget: SessionTranscriptRuntimeTarget;
    successorSessionId: string;
  }) => void;
  recoverTerminalTurn?: (
    session: { sessionId: string; sessionKey?: string },
    assertCurrent?: () => void,
  ) => Promise<string | undefined>;
  executeLocalTurn: <T>(
    claim: LocalTurnPlacementClaim,
    runLocal: () => Promise<T>,
    assertCurrent?: () => void,
  ) => Promise<T>;
  executeTurn: (
    claim: LocalTurnPlacementClaim,
    params: SessionPlacementTurnParams,
    runLocal: () => Promise<EmbeddedAgentRunResult>,
    onAdmitted?: () => void,
    assertCurrent?: () => void,
  ) => Promise<EmbeddedAgentRunResult>;
};

type PlacementSandboxAdmissionProvider = SessionPlacementAdmissionProvider & {
  prepareSandbox?: (
    params: SessionPlacementSandboxParams,
  ) => Promise<PreparedSessionPlacementSandbox>;
};

type SessionPlacementAdmissionState = {
  provider?: PlacementSandboxAdmissionProvider;
};

// Runtime chunks share one provider. The identity guard keeps an older gateway
// shutdown from clearing a newer lifecycle's admission gate.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementAdmissionState"),
  (): SessionPlacementAdmissionState => ({}),
);
export function installSessionPlacementAdmissionProvider(
  provider: SessionPlacementAdmissionProvider,
): () => void {
  state.provider = provider as PlacementSandboxAdmissionProvider;
  return () => {
    if (state.provider === provider) {
      state.provider = undefined;
    }
  };
}

/** Carries placement-owned runtime selection into candidate preparation and execution. */
export async function resolveSessionPlacementRuntimeOverride(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
): Promise<string | undefined> {
  const provider = state.provider;
  const runtime = await provider?.resolveRuntimeOverride?.(identity);
  if (state.provider !== provider) {
    throw createAbortError("session placement owner changed during runtime selection");
  }
  return runtime;
}

const requiredPlacementScope = resolveGlobalSingleton(
  Symbol.for("openclaw.requiredSessionPlacementScope"),
  () =>
    new AsyncLocalStorage<{
      identity: Omit<LocalTurnPlacementClaim, "runId">;
      provider: SessionPlacementAdmissionProvider;
      assertPlacementCurrent: () => void;
    }>(),
);

/** Nested entry points consume this run's owner-held admission, never a cached permission. */
export async function withRequiredSessionPlacement<T>(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
  options: { config?: OpenClawConfig; assertCurrent?: () => void; signal?: AbortSignal },
  task: () => Promise<T>,
): Promise<T> {
  const inherited = requiredPlacementScope.getStore();
  if (
    inherited &&
    inherited.identity.sessionId === identity.sessionId &&
    inherited.identity.agentId === identity.agentId &&
    inherited.identity.sessionKey === identity.sessionKey
  ) {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    if (state.provider !== inherited.provider) {
      throw createAbortError("session placement owner changed during required worker preparation");
    }
    inherited.assertPlacementCurrent();
    return await task();
  }
  const required =
    getRuntimeConfig().cloudWorkers?.requiredProfile ??
    options.config?.cloudWorkers?.requiredProfile;
  if (!required) {
    return await task();
  }
  const provider = state.provider;
  if (!identity.sessionKey?.trim() || !provider?.withRequiredSession) {
    throw new Error(
      "Required worker execution needs a real session and an available Gateway placement owner; sessionless model helpers are unsupported.",
    );
  }
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    if (state.provider !== provider) {
      throw createAbortError("session placement owner changed during required worker preparation");
    }
  };
  assertCurrent();
  return await provider.withRequiredSession(
    identity,
    async (assertPlacementCurrent) => {
      assertCurrent();
      assertPlacementCurrent();
      return await requiredPlacementScope.run(
        { identity: { ...identity }, provider, assertPlacementCurrent },
        task,
      );
    },
    assertCurrent,
    options.signal,
  );
}

export function sessionPlacementUsesWorkerInference(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
): boolean {
  return state.provider?.usesWorkerInference?.(identity) === true;
}

/** Captures the exact placement owner, including standalone absence, before awaited work. */
export function captureSessionPlacementCompactionSuccessorAssertion(): SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"] {
  const provider = state.provider;
  return (params) => {
    if (state.provider !== provider) {
      throw new Error("session placement owner changed during compaction successor acceptance");
    }
    provider?.assertCompactionSuccessorAllowed(params);
  };
}

// Placement can register a cancellation proxy before runtime/tool preparation.
// Only an exact continuation retains caller fences; independently admitted work
// must enter its own runtime scope instead of borrowing its launching tool's.
function withPlacementTurnCallerScope<T>(
  params: Pick<RunEmbeddedAgentParams, "admittedRunContext" | "preparedRunAdmission">,
  task: () => T,
): T {
  const instance =
    params.admittedRunContext?.operationalRunInstance ??
    params.preparedRunAdmission?.operationalRunInstance;
  return instance && getGatewayToolCallerIdentity()?.operationalRunInstance === instance
    ? task()
    : withoutGatewayToolCallerIdentity(task);
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
  onAdmitted?: () => void,
): Promise<EmbeddedAgentRunResult> {
  let admitted = false;
  const admitTurn = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    onAdmitted?.();
  };
  // Providers may execute locally or remotely; both must release queue ownership
  // only when their actual execution path has acquired its placement claim.
  const runAdmittedLocalTurn = async () => {
    assertRequiredWorkerLocalExecution(getRuntimeConfig(), "Gateway");
    assertRequiredWorkerLocalExecution(params.config ?? {}, "Gateway");
    const settle = resolveSessionPlacementForcedTerminalSettlement();
    const assertCurrent = resolveSessionPlacementTurnSettlementAssertion();
    if (params.replyOperation && settle) {
      // Preflight can stall before an embedded handle exists. The exact reply
      // owner must release and fence its admitted claim before waking a successor.
      registerReplyOperationSuccessorBarrier({
        operation: params.replyOperation,
        sessionId: claim.sessionId,
        sessionKeys: [params.replyOperation.key],
        start: settle,
      });
    }
    assertCurrent?.();
    admitTurn();
    assertCurrent?.();
    const result = await task();
    assertCurrent?.();
    return result;
  };
  const provider = state.provider;
  const lifecycleGeneration =
    params.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(claim.runId);
  const assertAdmittedRunCurrent = params.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.abortSignal)
    : undefined;
  const assertCurrent = composeSessionSourceAssertion(
    [params.preparedRunAdmission?.assertSourceCurrent, assertAdmittedRunCurrent],
    (assertSources) => {
      params.abortSignal?.throwIfAborted();
      // Setup waits retain the ingress and execution owners through worker preparation.
      assertSources();
      if (params.admittedRunContext && !assertAdmittedRunCurrent) {
        throw createAbortError("admitted run authority is no longer active");
      }
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
      if (state.provider !== provider) {
        throw createAbortError("session placement owner changed during turn admission");
      }
    },
  );
  const result = await withPlacementTurnCallerScope(params, () =>
    withoutSessionPlacementForcedTerminalSettlement(() =>
      provider
        ? provider.executeTurn(claim, params, runAdmittedLocalTurn, admitTurn, assertCurrent)
        : runAdmittedLocalTurn(),
    ),
  );
  if (result.meta.executionTrace?.runner === "cli" && params.isFinalFallbackAttempt === undefined) {
    // Standalone CLI completion releases placement before admitting a successor;
    // fallback candidates leave the handoff to their logical run entry.
    await settleRequesterRun({ ...params, ...claim }, result, assertCurrent);
  }
  return result;
}

/** Serializes direct CLI turns with every runtime before acquiring placement ownership. */
export async function withLocalSessionPlacementTurnSettlement(
  claim: LocalTurnPlacementClaim,
  task: (assertSettlementCurrent: () => void) => Promise<EmbeddedAgentRunResult>,
  options: Pick<
    RunEmbeddedAgentParams,
    | "abortSignal"
    | "lifecycleGeneration"
    | "trigger"
    | "inputProvenance"
    | "admittedRunContext"
    | "preparedRunAdmission"
    | "isFinalFallbackAttempt"
  > = {},
): Promise<EmbeddedAgentRunResult> {
  const assertLocalAllowed = () => {
    assertRequiredWorkerLocalExecution(getRuntimeConfig(), "Local CLI");
  };
  assertLocalAllowed();
  const provider = state.provider;
  const lifecycleGeneration =
    options.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(claim.runId);
  const assertAdmittedRunCurrent = options.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(options.admittedRunContext, options.abortSignal)
    : undefined;
  const assertOwnerCurrent = () => {
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    if (state.provider !== provider) {
      throw createAbortError("session placement owner changed during turn admission");
    }
  };
  const assertCurrent = () => {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : createAbortError("Operation aborted", { cause: options.abortSignal.reason });
    }
    assertOwnerCurrent();
  };
  assertCurrent();
  const releaseForeground =
    resolveEmbeddedRunSessionLanePolicy(options.trigger, options.inputProvenance).priority ===
    "foreground"
      ? await beginForegroundSessionMaintenance(claim.sessionKey ?? claim.sessionId)
      : undefined;
  const releaseQueuedContext = retainQueuedAgentRunContext(claim.runId, lifecycleGeneration);
  let releaseCapacityWait: (() => void) | undefined;
  try {
    return await enqueueCommandInLane(
      resolveSessionLane(claim.sessionKey?.trim() || claim.sessionId),
      async (taskMarker) => {
        assertCurrent();
        const runLocal = async () => {
          assertLocalAllowed();
          // Placement admission can itself await work. A cancelled or replaced
          // queue owner must never execute through the captured provider.
          assertCurrent();
          const assertClaimCurrent = resolveSessionPlacementTurnSettlementAssertion();
          let open = true;
          const assertSettlementCurrent = () => {
            // Queue reset closes this task even if its callback has not returned.
            if (!open || !isCommandLaneTaskMarkerCurrent(taskMarker)) {
              throw createSessionPlacementSettlementClosedAbortError();
            }
            assertOwnerCurrent();
            assertClaimCurrent?.();
          };
          try {
            assertSettlementCurrent();
            releaseCapacityWait?.();
            releaseQueuedContext?.("admitted");
            return await task(assertSettlementCurrent);
          } finally {
            open = false;
          }
        };
        const result = await withPlacementTurnCallerScope(options, () =>
          withoutSessionPlacementForcedTerminalSettlement(() =>
            provider ? provider.executeLocalTurn(claim, runLocal, assertCurrent) : runLocal(),
          ),
        );
        if (options.isFinalFallbackAttempt === undefined) {
          // Candidate classification is provisional until the outer entry accepts it.
          await settleRequesterRun({ ...options, ...claim }, result, () => {
            assertCurrent();
            options.preparedRunAdmission?.assertSourceCurrent();
            if (options.admittedRunContext && !assertAdmittedRunCurrent) {
              throw createAbortError("admitted run authority is no longer active");
            }
            assertAdmittedRunCurrent?.();
            if (!isCommandLaneTaskMarkerCurrent(taskMarker)) {
              throw createSessionPlacementSettlementClosedAbortError();
            }
          });
        }
        return result;
      },
      {
        sessionTarget: claim,
        priority: resolveEmbeddedRunSessionLanePolicy(options.trigger, options.inputProvenance)
          .priority,
        onQueued: () => {
          releaseCapacityWait = registerAgentRunCapacityWait(claim.runId, lifecycleGeneration);
        },
      },
    );
  } finally {
    releaseForeground?.();
    releaseCapacityWait?.();
    releaseQueuedContext?.("abandoned");
  }
}

/** Retains the selected placement owner, including absence, until its consumer settles. */
export async function prepareSessionPlacementSandbox(
  params: SessionPlacementSandboxParams,
): Promise<PreparedSessionPlacementSandbox> {
  const provider = state.provider;
  const prepared = await provider?.prepareSandbox?.(params);
  let released = false;
  const assertCurrent = () => {
    if (released || state.provider !== provider) {
      throw createAbortError("session placement owner changed during sandbox use");
    }
    prepared?.assertCurrent();
  };
  try {
    assertCurrent();
    return {
      sandbox: prepared?.sandbox ?? null,
      assertCurrent,
      [Symbol.dispose]() {
        released = true;
        prepared?.[Symbol.dispose]();
      },
    };
  } catch (error) {
    prepared?.[Symbol.dispose]();
    throw error;
  }
}

/** The current placement owner alone can settle a proven terminal worker turn. */
export async function recoverTerminalSessionPlacementTurn(
  session: { sessionId: string; sessionKey?: string },
  assertCurrent?: () => void,
): Promise<string | undefined> {
  const provider = state.provider;
  return await provider?.recoverTerminalTurn?.(session, () => {
    assertCurrent?.();
    if (state.provider !== provider) {
      throw new Error("session placement owner changed during terminal recovery");
    }
  });
}
