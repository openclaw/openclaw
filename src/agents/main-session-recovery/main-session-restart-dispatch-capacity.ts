import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { registerAgentRunCapacityWait } from "../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  hasLiveAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { MainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { repairMainSessionRecoveryMutation } from "./main-session-recovery-lifecycle.js";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryStoreTarget,
} from "./main-session-recovery-store.js";
import type { MainSessionRecoveryObservation } from "./main-session-recovery-types.js";
import {
  dispatchRestartRecoveryUntilStarted,
  type RestartRecoveryDispatchStartOutcome,
} from "./main-session-restart-dispatch-start.js";
import { mainSessionRecoveryLog } from "./main-session-restart-recovery-shared.js";

/** Keep a known scheduler wait durable and visible without reserving a dispatch attempt. */
export async function acquireRestartRecoveryCapacity(params: {
  capacity?: MainSessionRecoveryCapacity;
  observation: MainSessionRecoveryObservation;
  lifecycleGeneration: string;
  runId: string;
  shouldContinue: () => boolean;
  assertCurrent?: () => void;
  target: MainSessionRecoveryStoreTarget;
}) {
  let observation = params.observation;
  let waiting = false;
  let contextClaim: string | undefined;
  let releaseWait: (() => void) | undefined;
  let release: (() => void) | undefined;
  const clearWaiting = async () => {
    if (!waiting) {
      return;
    }
    const cleared = await commitMainSessionRecovery({
      target: params.target,
      expectedSessionId: observation.sessionId,
      scanAliases: true,
      requireWriteSuccess: true,
      command: {
        kind: "cancel_capacity_wait",
        wait: {
          ...observation,
          runId: params.runId,
          lifecycleGeneration: params.lifecycleGeneration,
        },
      },
    });
    waiting = false;
    if (cleared.entry?.mainRestartRecovery && cleared.entry.sessionId === observation.sessionId) {
      observation = { ...observation, revision: cleared.entry.mainRestartRecovery.revision };
    }
  };
  try {
    release = await params.capacity?.acquire(params.shouldContinue, async () => {
      const marked = await commitMainSessionRecovery({
        target: params.target,
        shouldContinue: params.shouldContinue,
        assertCommitAllowed: params.assertCurrent,
        requireWriteSuccess: true,
        command: {
          kind: "wait_capacity",
          observation,
          lifecycleGeneration: params.lifecycleGeneration,
          runId: params.runId,
          now: Date.now(),
        },
      });
      if (marked.transition.kind !== "applied" || !marked.entry?.mainRestartRecovery) {
        throw new Error("Restart recovery capacity wait lost its session intent");
      }
      waiting = true;
      observation = { ...observation, revision: marked.entry.mainRestartRecovery.revision };
      contextClaim = claimAgentRunContext(
        params.runId,
        {
          sessionId: observation.sessionId,
          sessionKey: params.target.sessionKey,
          agentId: params.target.agentId,
          lifecycleGeneration: params.lifecycleGeneration,
          mainSessionRestartRecovery: true,
          projectSessionActive: true,
          isControlUiVisible: true,
        },
        { trackOwner: true, ownsContext: true, protectFromSweep: true },
      );
      if (contextClaim) {
        releaseWait = registerAgentRunCapacityWait(params.runId, params.lifecycleGeneration);
      }
    });
    await clearWaiting();
    return !params.shouldContinue() || (params.capacity && !release)
      ? undefined
      : { observation, release };
  } catch (error) {
    release?.();
    await repairMainSessionRecoveryMutation({
      mutation: clearWaiting,
      onDeferredSuccess: () => {},
      onError: () => mainSessionRecoveryLog.warn("Failed to clear restart recovery capacity wait"),
    });
    throw error;
  } finally {
    releaseWait?.();
    releaseAgentRunContext(params.runId, contextClaim);
    if (!params.shouldContinue()) {
      release?.();
    }
  }
}

export async function dispatchRestartRecoveryWithinCapacity(params: {
  agentParams: AgentRunRequest;
  operatorRunAuthority?: AdmittedRunOperatorAuthority;
  capacity?: MainSessionRecoveryCapacity;
  releaseCapacity?: () => void;
  gatewayRuntime: GatewayRecoveryRuntime;
  onSettled?: () => void;
  onStarted?: () => Promise<void>;
  beginDispatch: () => boolean;
  shouldContinue: () => boolean;
}): Promise<RestartRecoveryDispatchStartOutcome | undefined> {
  const terminalRunId = params.agentParams.idempotencyKey;
  if (!terminalRunId) {
    throw new Error("Restart recovery capacity requires an idempotency key");
  }
  const release = params.releaseCapacity ?? (await params.capacity?.acquire(params.shouldContinue));
  if (params.capacity && !release) {
    return undefined;
  }
  if (!params.beginDispatch()) {
    release?.();
    return undefined;
  }
  let settled = false;
  const onSettled = () => {
    if (!settled) {
      settled = true;
      try {
        release?.();
      } finally {
        params.onSettled?.();
      }
    }
  };
  try {
    const outcome = await dispatchRestartRecoveryUntilStarted({
      agentParams: params.agentParams,
      operatorRunAuthority: params.operatorRunAuthority,
      gatewayRuntime: params.gatewayRuntime,
      onSettled,
      onStarted: params.onStarted,
    });
    if (outcome.kind !== "started") {
      onSettled();
    } else if (release) {
      void releaseCapacityAtTerminal({
        gatewayRuntime: params.gatewayRuntime,
        onSettled,
        runId: terminalRunId,
      });
    }
    return outcome;
  } catch (error) {
    onSettled();
    throw error;
  }
}

async function releaseCapacityAtTerminal(params: {
  gatewayRuntime: GatewayRecoveryRuntime;
  onSettled: () => void;
  runId: string;
}): Promise<void> {
  try {
    // After start the permit belongs to the registered child, not the retired
    // preparation reader. Keep it until a real terminal result or owner release.
    while (hasLiveAgentRunContext(params.runId)) {
      try {
        const result = await params.gatewayRuntime.waitForAgent<{
          endedAt?: unknown;
          status?: unknown;
        }>({ runId: params.runId, timeoutMs: 30_000 }, 35_000);
        if (result.status !== "timeout" || typeof result.endedAt === "number") {
          return;
        }
        if (!hasLiveAgentRunContext(params.runId)) {
          return;
        }
      } catch {
        if (!hasLiveAgentRunContext(params.runId)) {
          return;
        }
        await sleepWithAbort(1_000, undefined, { ref: false });
      }
    }
  } finally {
    params.onSettled();
  }
}
