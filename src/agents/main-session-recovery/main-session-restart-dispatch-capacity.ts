import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { MainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import {
  dispatchRestartRecoveryUntilStarted,
  type RestartRecoveryDispatchStartOutcome,
} from "./main-session-restart-dispatch-start.js";

const log = createSubsystemLogger("main-session-restart-recovery");

export async function dispatchRestartRecoveryWithinCapacity(params: {
  agentParams: AgentRunRequest;
  capacity?: MainSessionRecoveryCapacity;
  gatewayRuntime: GatewayRecoveryRuntime;
  onSettled?: () => void;
  beginDispatch: () => boolean;
  shouldContinue: () => boolean;
  holdTimeoutMs?: number;
  retainPollMs?: number;
}): Promise<RestartRecoveryDispatchStartOutcome | undefined> {
  const terminalRunId = params.agentParams.idempotencyKey;
  if (!terminalRunId) {
    throw new Error("Restart recovery capacity requires an idempotency key");
  }
  const release = await params.capacity?.acquire(params.shouldContinue);
  if (params.capacity && !release) {
    return undefined;
  }
  if (!params.beginDispatch()) {
    release?.();
    return undefined;
  }
  let settled = false;
  const onSettled = () => {
    release?.();
    if (!settled) {
      settled = true;
      params.onSettled?.();
    }
  };
  try {
    const outcome = await dispatchRestartRecoveryUntilStarted({
      agentParams: params.agentParams,
      gatewayRuntime: params.gatewayRuntime,
      onSettled,
    });
    if (outcome.kind !== "started") {
      onSettled();
    } else if (release) {
      void releaseCapacityAtTerminal({
        gatewayRuntime: params.gatewayRuntime,
        onSettled,
        runId: terminalRunId,
        shouldContinue: params.shouldContinue,
        holdTimeoutMs: params.holdTimeoutMs,
        retainPollMs: params.retainPollMs,
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
  shouldContinue: () => boolean;
  holdTimeoutMs?: number;
  retainPollMs?: number;
}): Promise<void> {
  const deadline = Date.now() + (params.holdTimeoutMs ?? 300_000);
  let settled = false;
  try {
    while (params.shouldContinue() && Date.now() < deadline) {
      try {
        const result = await params.gatewayRuntime.waitForAgent<{
          endedAt?: unknown;
          status?: unknown;
        }>({ runId: params.runId, timeoutMs: 30_000 }, 35_000);
        if (result.status !== "timeout" || typeof result.endedAt === "number") {
          settled = true;
          return;
        }
        if (!hasLiveAgentRunContext(params.runId)) {
          settled = true;
          return;
        }
      } catch {
        if (!hasLiveAgentRunContext(params.runId)) {
          settled = true;
          return;
        }
        await sleepWithAbort(1_000, undefined, { ref: false });
      }
    }
    if (params.shouldContinue() && Date.now() >= deadline) {
      if (!hasLiveAgentRunContext(params.runId)) {
        log.warn(`recovery capacity held beyond budget for run ${params.runId}, releasing`);
        settled = true;
        return;
      }
      // The run is still live past the hold budget. Keep the lease until the
      // run resolves or recovery admission stops (cancellation), preserving
      // the single-active-run invariant. A safe owner-controlled termination
      // path for a permanently live run is a separate maintainer decision.
      log.warn(
        `recovery capacity hold budget exhausted for live run ${params.runId}; retaining slot until run is no longer live`,
      );
      while (params.shouldContinue() && hasLiveAgentRunContext(params.runId)) {
        await sleepWithAbort(params.retainPollMs ?? 5_000, undefined, { ref: false });
      }
      // Exit: the run resolved, or admission stopped. Either way the lease
      // is released below. An admission stop is cleanup, not proof the run
      // has terminated.
      settled = true;
    }
  } finally {
    // Release the lease when the run settles, when it is no longer live, or
    // when recovery admission stops (cancellation). The last case is cleanup
    // so other recovery work can proceed; it does not mean the run itself
    // has terminated.
    if (settled || !params.shouldContinue()) {
      params.onSettled();
    }
  }
}
