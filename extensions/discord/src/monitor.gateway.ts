import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { DiscordGatewayHandle } from "./monitor/gateway-handle.js";
import { DiscordGatewayLifecycleError } from "./monitor/gateway-supervisor.js";
import type {
  DiscordGatewayEvent,
  DiscordGatewaySupervisor,
} from "./monitor/gateway-supervisor.js";

export { getDiscordGatewayEmitter } from "./monitor/gateway-supervisor.js";

type WaitForDiscordGatewayStopParams = {
  gateway?: DiscordGatewayHandle;
  abortSignal?: AbortSignal;
  gatewaySupervisor?: Pick<DiscordGatewaySupervisor, "attachLifecycle" | "detachLifecycle">;
  onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
  registerForceStop?: (forceStop: (err: unknown) => void) => void;
};

export async function waitForDiscordGatewayStop(
  params: WaitForDiscordGatewayStopParams,
): Promise<void> {
  const { gateway, abortSignal } = params;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        gateway?.disconnect?.();
      } finally {
        // remove listeners after disconnect so late "error" events emitted
        // during disconnect are still handled instead of becoming uncaught
        abortSignal?.removeEventListener("abort", onAbort);
        params.gatewaySupervisor?.detachLifecycle();
        settle();
      }
    };
    const finishReject = (err: unknown) => {
      finish(() => reject(toErrorObject(err, "Non-Error rejection")));
    };
    const onAbort = () => {
      finish(resolve);
    };
    const onGatewayEvent = (event: DiscordGatewayEvent) => {
      const shouldStop = (params.onGatewayEvent?.(event) ?? "stop") === "stop";
      if (shouldStop) {
        finishReject(new DiscordGatewayLifecycleError(event));
      }
    };
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    params.gatewaySupervisor?.attachLifecycle(onGatewayEvent);
    params.registerForceStop?.(finishReject);
  });
}
