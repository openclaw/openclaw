import type { GatewayClientOptions } from "./client.js";
import {
  waitForEventLoopReady,
  type EventLoopReadyOptions,
  type EventLoopReadyResult,
} from "./event-loop-ready.js";
import { resolveConnectChallengeTimeoutMs } from "./timeouts.js";

export type GatewayClientStartable = {
  /** Starts the underlying gateway connection after readiness succeeds. */
  start(): void;
};

/** Injectable readiness waiter used by tests and alternate event-loop probes. */
export type EventLoopReadyWaiter = (
  options?: EventLoopReadyOptions,
) => Promise<EventLoopReadyResult>;

/** Timeout and abort controls for delaying client start until the loop can process IO. */
export type GatewayClientStartReadinessOptions = {
  /** Explicit readiness wait cap; wins over client connection timeout settings. */
  timeoutMs?: number;
  /** Client connection settings used to derive a readiness cap when timeoutMs is absent. */
  clientOptions?: Pick<
    GatewayClientOptions,
    "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs"
  >;
  /** Cancels readiness without starting the client. */
  signal?: AbortSignal;
};

function resolveGatewayClientStartReadinessTimeoutMs(
  options: GatewayClientStartReadinessOptions = {},
): number {
  if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) {
    return options.timeoutMs;
  }
  const clientOptions = options.clientOptions ?? {};
  const timeoutOverride =
    // Prefer the challenge watchdog over the older connectDelayMs alias so
    // readiness stays aligned with the server-side preauth handshake window.
    typeof clientOptions.connectChallengeTimeoutMs === "number" &&
    Number.isFinite(clientOptions.connectChallengeTimeoutMs)
      ? clientOptions.connectChallengeTimeoutMs
      : typeof clientOptions.connectDelayMs === "number" &&
          Number.isFinite(clientOptions.connectDelayMs)
        ? clientOptions.connectDelayMs
        : undefined;
  return resolveConnectChallengeTimeoutMs(timeoutOverride, {
    configuredTimeoutMs: clientOptions.preauthHandshakeTimeoutMs,
  });
}

/** Starts a gateway client only after the supplied readiness probe succeeds. */
export async function startGatewayClientWithReadinessWait(
  waitForReady: EventLoopReadyWaiter,
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  const readiness = await waitForReady({
    maxWaitMs: resolveGatewayClientStartReadinessTimeoutMs(options),
    signal: options.signal,
  });
  // The readiness waiter can race with abort delivery; gate start on both the
  // returned state and the current signal so aborted startup remains side-effect-free.
  if (readiness.ready && !readiness.aborted && options.signal?.aborted !== true) {
    client.start();
  }
  return readiness;
}

/** Starts a gateway client after the default event-loop readiness probe succeeds. */
export async function startGatewayClientWhenEventLoopReady(
  client: GatewayClientStartable,
  options: GatewayClientStartReadinessOptions = {},
): Promise<EventLoopReadyResult> {
  return startGatewayClientWithReadinessWait(waitForEventLoopReady, client, options);
}
