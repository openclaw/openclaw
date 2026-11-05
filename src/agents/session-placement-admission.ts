import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeConfig } from "../config/config.js";
import { assertRequiredWorkerLocalExecution } from "../config/required-worker-profile.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import {
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { retainQueuedAgentRunContext } from "../infra/agent-run-registry.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { registerReplyOperationSuccessorBarrier } from "../sessions/session-controller.js";
import {
  assertSessionControllerOperation,
  isCurrentSessionControllerOperation,
} from "../sessions/session-controller.state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveAdmittedRunActiveAssertion } from "./admitted-run-context.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import type { RunEmbeddedAgentInternalParams } from "./embedded-agent-runner/run/internal-params.js";
import { resolveEmbeddedRunSessionLanePolicy } from "./embedded-agent-runner/run/lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { settleRequesterRun } from "./requester-run-settlement.js";
import { createSessionPlacementSettlementClosedAbortError } from "./run-termination.js";
import type { SandboxContext } from "./sandbox/types.js";
import { beginForegroundSessionMaintenance } from "./session-maintenance/coordinator.js";
import type {
  LocalTurnPlacementClaim,
  RequiredSessionPlacementAdmission,
} from "./session-placement-admission.types.js";
import {
  resolveSessionPlacementForcedTerminalSettlement,
  resolveSessionPlacementTurnSettlementAssertion,
  withoutSessionPlacementForcedTerminalSettlement,
} from "./session-placement-forced-terminal-settlement.js";
import { withSessionPlacementTurnInput } from "./session-placement-turn-input.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

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
  withRequiredSession?: RequiredSessionPlacementAdmission;
  usesWorkerInference?: (identity: Omit<LocalTurnPlacementClaim, "runId">) => Promise<boolean>;
  resolveRuntimeOverride?: (
    identity: Omit<LocalTurnPlacementClaim, "runId">,
  ) => Promise<string | undefined>;
  assertCompactionSuccessorAllowed: (params: {
    currentTarget: SessionTranscriptRuntimeTarget;
    successorSessionId: string;
  }) => void;
  recoverTerminalTurn?: (
    session: { sessionId: string; sessionKey?: string; operation?: ReplyOperation },
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
  return state.provider?.resolveRuntimeOverride?.(identity);
}

const requiredPlacementScope = resolveGlobalSingleton(
  Symbol.for("openclaw.requiredSessionPlacementScope"),
  () =>
    new AsyncLocalStorage<{
      identity: Omit<LocalTurnPlacementClaim, "runId">;
      provider: SessionPlacementAdmissionProvider;
      assertPlacementCurrent: SessionSourceAssertion;
    }>(),
);

/** Independent turns acquire placement custody instead of inheriting their predecessor's. */
export function withoutRequiredSessionPlacement<T>(task: () => T): T {
  return requiredPlacementScope.exit(task);
}

/** Nested entry points consume this run's owner-held admission, never a cached permission. */
export async function withRequiredSessionPlacement<T>(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
  options: {
    config?: OpenClawConfig;
    assertCurrent?: SessionSourceAssertion;
    signal?: AbortSignal;
  },
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
  const assertCurrent = composeSessionSourceAssertion([options.assertCurrent], (assertSource) => {
    options.signal?.throwIfAborted();
    assertSource();
    if (state.provider !== provider) {
      throw createAbortError("session placement owner changed during required worker preparation");
    }
  });
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

export async function sessionPlacementUsesWorkerInference(
  identity: Omit<LocalTurnPlacementClaim, "runId">,
): Promise<boolean> {
  return (await state.provider?.usesWorkerInference?.(identity)) === true;
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
    : withoutGatewayToolCallerIdentity(() => runWithoutOwnedSessionTranscriptWrites(task));
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: (signal: AbortSignal) => Promise<EmbeddedAgentRunResult>,
  onAdmitted?: () => void,
): Promise<EmbeddedAgentRunResult> {
  const config = params.config ?? getRuntimeConfig();
  const { sessionAgentId } = resolveSessionAgentIds({
    config,
    sessionKey: claim.sessionKey,
    agentId: claim.agentId,
  });
  return await withSessionTurn(
    {
      ...claim,
      agentId: sessionAgentId,
      sessionTarget: params.sessionTarget,
      storePath:
        params.sessionTarget?.storePath ??
        resolveSessionStorePathCore(config.session?.store, { agentId: sessionAgentId }),
      replyOperation: params.replyOperation,
      abortSignal: params.abortSignal,
      detached: params.sessionPersistence === "detached",
    },
    async (operation, signal) => {
      const admitted = { ...params, replyOperation: operation, abortSignal: signal };
      return await executeAdmittedSessionPlacementTurn(
        claim,
        admitted,
        () => withSessionPlacementTurnInput(params, admitted, () => task(signal)),
        onAdmitted,
      );
    },
  );
}

async function executeAdmittedSessionPlacementTurn(
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
    const assertPlacementCurrent = resolveSessionPlacementTurnSettlementAssertion();
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
    assertPlacementCurrent?.();
    admitTurn();
    params.abortSignal?.throwIfAborted();
    if (params.replyOperation) {
      assertSessionControllerOperation(params.replyOperation);
    }
    assertPlacementCurrent?.();
    const result = await task();
    assertPlacementCurrent?.();
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
  task: (assertSettlementCurrent: SessionSourceAssertion) => Promise<EmbeddedAgentRunResult>,
  options: Pick<
    RunEmbeddedAgentParams,
    | "abortSignal"
    | "lifecycleGeneration"
    | "trigger"
    | "inputProvenance"
    | "admittedRunContext"
    | "preparedRunAdmission"
    | "isFinalFallbackAttempt"
    | "replyOperation"
    | "sessionTarget"
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
  let releaseForeground: (() => void) | undefined;
  const releaseQueuedContext = retainQueuedAgentRunContext(claim.runId, lifecycleGeneration);
  try {
    return await withSessionTurn(
      {
        ...claim,
        abortSignal: options.abortSignal,
        replyOperation: options.replyOperation,
        sessionTarget: options.sessionTarget,
      },
      async (operation, signal) => {
        const assertAdmissionCurrent = () => {
          signal.throwIfAborted();
          assertCurrent();
        };
        assertAdmissionCurrent();
        operation?.markWaitingForDeferredMaintenance();
        try {
          releaseForeground =
            resolveEmbeddedRunSessionLanePolicy(options.trigger, options.inputProvenance)
              .priority === "foreground"
              ? await beginForegroundSessionMaintenance(claim.sessionKey ?? claim.sessionId)
              : undefined;
        } finally {
          operation?.markDeferredMaintenanceWaitEnded();
        }
        const runLocal = async () => {
          assertLocalAllowed();
          // Placement admission can itself await work. A cancelled or replaced
          // queue owner must never execute through the captured provider.
          assertAdmissionCurrent();
          const assertClaimCurrent = resolveSessionPlacementTurnSettlementAssertion();
          let open = true;
          const assertSettlementCurrent = composeSessionSourceAssertion(
            [assertClaimCurrent],
            (assertSource) => {
              // Cancellation keeps terminal custody until cleanup releases this turn.
              if (!open || (operation && !isCurrentSessionControllerOperation(operation))) {
                throw createSessionPlacementSettlementClosedAbortError();
              }
              assertOwnerCurrent();
              assertSource();
            },
          );
          const cleanup = resolveSessionPlacementForcedTerminalSettlement();
          const releaseCleanup = cleanup && operation?.registerExecutionCleanup(cleanup);
          try {
            assertSettlementCurrent();
            releaseQueuedContext?.("admitted");
            return await task(assertSettlementCurrent);
          } finally {
            releaseCleanup?.();
            open = false;
          }
        };
        const result = await withPlacementTurnCallerScope(options, () =>
          withoutSessionPlacementForcedTerminalSettlement(() =>
            provider
              ? provider.executeLocalTurn(claim, runLocal, assertAdmissionCurrent)
              : runLocal(),
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
            if (operation) {
              assertSessionControllerOperation(operation);
            }
          });
        }
        return result;
      },
    );
  } finally {
    releaseForeground?.();
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
  session: { sessionId: string; sessionKey?: string; operation?: ReplyOperation },
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
