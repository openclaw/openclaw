import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import type { AgentRunRequest } from "../../gateway/server-methods/agent-request-types.js";
import { hasLiveAgentRunContext } from "../../infra/agent-run-registry.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import type { MainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import {
  dispatchRestartRecoveryUntilStarted,
  type RestartRecoveryDispatchStartOutcome,
} from "./main-session-restart-dispatch-start.js";

export async function dispatchRestartRecoveryWithinCapacity(params: {
  agentParams: AgentRunRequest;
  capacity?: MainSessionRecoveryCapacity;
  gatewayRuntime: GatewayRecoveryRuntime;
  onSettled?: () => void;
  beginDispatch: () => boolean;
  shouldContinue: () => boolean;
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
}): Promise<void> {
  try {
    while (params.shouldContinue()) {
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
