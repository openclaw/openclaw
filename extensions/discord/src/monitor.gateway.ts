import type { EventEmitter } from "node:events";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { DiscordGatewayHandle } from "./monitor/gateway-handle.js";
import type {
  DiscordGatewayEvent,
  DiscordGatewaySupervisor,
} from "./monitor/gateway-supervisor.js";

/**
 * Call `gateway.disconnect()` and catch the known Carbon synchronous throw.
 *
 * Carbon's `SafeGatewayPlugin.handleReconnectionAttempt` throws synchronously
 * inside the WebSocket close callback when `maxAttempts` is 0 or the socket
 * closes with no close frame (code 1005). This throw bypasses the gateway
 * supervisor's event-based error handler. Catching it here prevents an uncaught
 * exception from crashing the gateway process during health-monitor restarts.
 */
function safeDisconnect(gateway: DiscordGatewayHandle | undefined, runtime?: RuntimeEnv): void {
  try {
    gateway?.disconnect?.();
  } catch (err) {
    // This runs inside an abort/event callback — any re-thrown error would
    // escape as an uncaught exception (the same crash this fix addresses).
    // Log all errors: expected ones at info, unexpected ones at error.
    const message = String(err);
    if (message.includes("Max reconnect attempts")) {
      runtime?.log?.(`discord: suppressed expected Carbon throw during disconnect: ${message}`);
    } else {
      runtime?.error?.(
        `discord: unexpected error during disconnect (suppressed to avoid uncaught exception): ${message}`,
      );
    }
  }
}

export type WaitForDiscordGatewayStopParams = {
  gateway?: DiscordGatewayHandle;
  abortSignal?: AbortSignal;
  gatewaySupervisor?: Pick<DiscordGatewaySupervisor, "attachLifecycle" | "detachLifecycle">;
  onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
  registerForceStop?: (forceStop: (err: unknown) => void) => void;
};

export function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined {
  return (gateway as { emitter?: EventEmitter } | undefined)?.emitter;
}

export async function waitForDiscordGatewayStop(
  params: WaitForDiscordGatewayStopParams & { runtime?: RuntimeEnv },
): Promise<void> {
  const { gateway, abortSignal } = params;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      params.gatewaySupervisor?.detachLifecycle();
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        safeDisconnect(gateway, params.runtime);
      } finally {
        // remove listeners after disconnect so late "error" events emitted
        // during disconnect are still handled instead of becoming uncaught
        cleanup();
        resolve();
      }
    };
    const finishReject = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        safeDisconnect(gateway, params.runtime);
      } finally {
        cleanup();
        reject(err);
      }
    };
    const onAbort = () => {
      finishResolve();
    };
    const onGatewayEvent = (event: DiscordGatewayEvent) => {
      const shouldStop = (params.onGatewayEvent?.(event) ?? "stop") === "stop";
      if (shouldStop) {
        finishReject(event.err);
      }
    };
    const onForceStop = (err: unknown) => {
      finishReject(err);
    };
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    params.gatewaySupervisor?.attachLifecycle(onGatewayEvent);
    params.registerForceStop?.(onForceStop);
  });
}
