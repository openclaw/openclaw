import type { Client } from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { createArmableStallWatchdog } from "openclaw/plugin-sdk/channel-lifecycle";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const DISCORD_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DISCORD_GATEWAY_READY_POLL_MS = 250;

type GatewayReadyWaitResult = "ready" | "timeout" | "stopped";

async function waitForDiscordGatewayReady(params: {
  gateway?: Pick<GatewayPlugin, "isConnected">;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  beforePoll?: () => Promise<"continue" | "stop"> | "continue" | "stop";
}): Promise<GatewayReadyWaitResult> {
  const deadlineAt = Date.now() + params.timeoutMs;
  while (!params.abortSignal?.aborted) {
    const pollDecision = await params.beforePoll?.();
    if (pollDecision === "stop") {
      return "stopped";
    }
    if (params.gateway?.isConnected) {
      return "ready";
    }
    if (Date.now() >= deadlineAt) {
      return "timeout";
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, DISCORD_GATEWAY_READY_POLL_MS);
      timeout.unref?.();
    });
  }
  return "stopped";
}

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  client: Client;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  isDisallowedIntentsError: (err: unknown) => boolean;
  voiceManager: DiscordVoiceManager | null;
  voiceManagerRef: { current: DiscordVoiceManager | null };
  execApprovalsHandler: ExecApprovalsHandler | null;
  threadBindings: { stop: () => void };
  pendingGatewayErrors?: unknown[];
  releaseEarlyGatewayErrorGuard?: () => void;
  statusSink?: DiscordMonitorStatusSink;
}) {
  const HELLO_TIMEOUT_MS = 30000;
  const HELLO_CONNECTED_POLL_MS = 250;
  const MAX_CONSECUTIVE_HELLO_STALLS = 3;
  const RECONNECT_STALL_TIMEOUT_MS = 5 * 60_000;
  const gateway = params.client.getPlugin<GatewayPlugin>("gateway");
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });
  let lifecycleStopping = false;
  let forceStopHandler: ((err: unknown) => void) | undefined;
  let queuedForceStopError: unknown;

  const pushStatus = (patch: Parameters<DiscordMonitorStatusSink>[0]) => {
    params.statusSink?.(patch);
  };

  const triggerForceStop = (err: unknown) => {
    if (forceStopHandler) {
      forceStopHandler(err);
      return;
    }
    queuedForceStopError = err;
  };

  const reconnectStallWatchdog = createArmableStallWatchdog({
    label: `discord:${params.accountId}:reconnect`,
    timeoutMs: RECONNECT_STALL_TIMEOUT_MS,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
    onTimeout: () => {
      if (params.abortSignal?.aborted || lifecycleStopping) {
        return;
      }
      const at = Date.now();
      const error = new Error(
        `discord reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms`,
      );
      pushStatus({
        connected: false,
        lastEventAt: at,
        lastDisconnect: {
          at,
          error: error.message,
        },
        lastError: error.message,
      });
      params.runtime.error?.(
        danger(
          `discord: reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms; force-stopping monitor task`,
        ),
      );
      triggerForceStop(error);
    },
  });

  const onAbort = () => {
    lifecycleStopping = true;
    reconnectStallWatchdog.disarm();
    const at = Date.now();
    pushStatus({ connected: false, lastEventAt: at });
    if (!gateway) {
      return;
    }
    gatewayEmitter?.once("error", () => {});
    gateway.options.reconnect = { maxAttempts: 0 };
    gateway.disconnect();
  };

  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  let helloTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let helloConnectedPollId: ReturnType<typeof setInterval> | undefined;
  let consecutiveHelloStalls = 0;
  const clearHelloWatch = () => {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = undefined;
    }
    if (helloConnectedPollId) {
      clearInterval(helloConnectedPollId);
      helloConnectedPollId = undefined;
    }
  };
  const resetHelloStallCounter = () => {
    consecutiveHelloStalls = 0;
  };
  const parseGatewayCloseCode = (message: string): number | undefined => {
    const match = /code\s+(\d{3,5})/i.exec(message);
    if (!match?.[1]) {
      return undefined;
    }
    const code = Number.parseInt(match[1], 10);
    return Number.isFinite(code) ? code : undefined;
  };
  const clearResumeState = () => {
    const mutableGateway = gateway as
      | (GatewayPlugin & {
          state?: {
            sessionId?: string | null;
            resumeGatewayUrl?: string | null;
            sequence?: number | null;
          };
          sequence?: number | null;
        })
      | undefined;
    if (!mutableGateway?.state) {
      return;
    }
    mutableGateway.state.sessionId = null;
    mutableGateway.state.resumeGatewayUrl = null;
    mutableGateway.state.sequence = null;
    mutableGateway.sequence = null;
  };
  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    const at = Date.now();
    pushStatus({ lastEventAt: at });
    if (message.includes("WebSocket connection closed")) {
      // Carbon marks `isConnected` true only after READY/RESUMED and flips it
      // false during reconnect handling after this debug line is emitted.
      if (gateway?.isConnected) {
        resetHelloStallCounter();
      }
      reconnectStallWatchdog.arm(at);
      pushStatus({
        connected: false,
        lastDisconnect: {
          at,
          status: parseGatewayCloseCode(message),
        },
      });
      clearHelloWatch();
      return;
    }
    if (!message.includes("WebSocket connection opened")) {
      return;
    }
    reconnectStallWatchdog.disarm();
    clearHelloWatch();

    let sawConnected = gateway?.isConnected === true;
    if (sawConnected) {
      pushStatus({
        ...createConnectedChannelStatusPatch(at),
        lastDisconnect: null,
      });
    }
    helloConnectedPollId = setInterval(() => {
      if (!gateway?.isConnected) {
        return;
      }
      sawConnected = true;
      resetHelloStallCounter();
      const connectedAt = Date.now();
      reconnectStallWatchdog.disarm();
      pushStatus({
        ...createConnectedChannelStatusPatch(connectedAt),
        lastDisconnect: null,
      });
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = undefined;
      }
    }, HELLO_CONNECTED_POLL_MS);

    helloTimeoutId = setTimeout(() => {
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = undefined;
      }
      if (sawConnected || gateway?.isConnected) {
        resetHelloStallCounter();
      } else {
        consecutiveHelloStalls += 1;
        const forceFreshIdentify = consecutiveHelloStalls >= MAX_CONSECUTIVE_HELLO_STALLS;
        const stalledAt = Date.now();
        reconnectStallWatchdog.arm(stalledAt);
        pushStatus({
          connected: false,
          lastEventAt: stalledAt,
          lastDisconnect: {
            at: stalledAt,
            error: "hello-timeout",
          },
        });
        params.runtime.log?.(
          danger(
            forceFreshIdentify
              ? `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); forcing fresh identify`
              : `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); retrying resume`,
          ),
        );
        if (forceFreshIdentify) {
          clearResumeState();
          resetHelloStallCounter();
        }
        gateway?.disconnect();
        gateway?.connect(!forceFreshIdentify);
      }
      helloTimeoutId = undefined;
    }, HELLO_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);

  let sawDisallowedIntents = false;
  const logGatewayError = (err: unknown) => {
    if (params.isDisallowedIntentsError(err)) {
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
        ),
      );
      return;
    }
    params.runtime.error?.(danger(`discord gateway error: ${String(err)}`));
  };
  const shouldStopOnGatewayError = (err: unknown) => {
    const message = String(err);
    return (
      message.includes("Max reconnect attempts") ||
      message.includes("Fatal Gateway error") ||
      params.isDisallowedIntentsError(err)
    );
  };
  const drainPendingGatewayErrors = (): "continue" | "stop" => {
    const pendingGatewayErrors = params.pendingGatewayErrors ?? [];
    if (pendingGatewayErrors.length === 0) {
      return "continue";
    }
    const queuedErrors = [...pendingGatewayErrors];
    pendingGatewayErrors.length = 0;
    for (const err of queuedErrors) {
      logGatewayError(err);
      if (!shouldStopOnGatewayError(err)) {
        continue;
      }
      if (params.isDisallowedIntentsError(err)) {
        return "stop";
      }
      throw err;
    }
    return "continue";
  };
  try {
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.start();
    }

    // Drain gateway errors emitted before lifecycle listeners were attached.
    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    // Carbon starts the gateway during client construction, before OpenClaw can
    // attach lifecycle listeners. Require a READY/RESUMED-connected gateway
    // before continuing so the monitor does not look healthy while silently
    // missing inbound events.
    if (gateway && !gateway.isConnected && !lifecycleStopping) {
      const initialReady = await waitForDiscordGatewayReady({
        gateway,
        abortSignal: params.abortSignal,
        timeoutMs: DISCORD_GATEWAY_READY_TIMEOUT_MS,
        beforePoll: drainPendingGatewayErrors,
      });
      if (initialReady === "stopped" || lifecycleStopping) {
        return;
      }
      if (initialReady === "timeout" && !lifecycleStopping) {
        params.runtime.error?.(
          danger(
            `discord: gateway was not ready after ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms; forcing a fresh reconnect`,
          ),
        );
        const startupRetryAt = Date.now();
        pushStatus({
          connected: false,
          lastEventAt: startupRetryAt,
          lastDisconnect: {
            at: startupRetryAt,
            error: "startup-not-ready",
          },
        });
        gateway?.disconnect();
        gateway?.connect(false);
        const reconnected = await waitForDiscordGatewayReady({
          gateway,
          abortSignal: params.abortSignal,
          timeoutMs: DISCORD_GATEWAY_READY_TIMEOUT_MS,
          beforePoll: drainPendingGatewayErrors,
        });
        if (reconnected === "stopped" || lifecycleStopping) {
          return;
        }
        if (reconnected === "timeout" && !lifecycleStopping) {
          // The forced reconnect also timed out — likely a transient network
          // outage during startup. Rather than giving up immediately (which
          // leaves the channel permanently dead until the gateway restarts),
          // retry with exponential backoff, mirroring the post-connected
          // reconnect-stall-watchdog behaviour.
          const STARTUP_MAX_BACKOFF_ATTEMPTS = 8;
          const STARTUP_BACKOFF_BASE_MS = DISCORD_GATEWAY_READY_TIMEOUT_MS;
          const STARTUP_BACKOFF_MAX_MS = RECONNECT_STALL_TIMEOUT_MS;

          let startupRecovered = false;
          for (
            let backoffAttempt = 1;
            backoffAttempt <= STARTUP_MAX_BACKOFF_ATTEMPTS && !lifecycleStopping;
            backoffAttempt++
          ) {
            const delayMs = Math.min(
              STARTUP_BACKOFF_BASE_MS * (1 << Math.min(backoffAttempt - 1, 5)),
              STARTUP_BACKOFF_MAX_MS,
            );
            const stuckAt = Date.now();
            params.runtime.error?.(
              danger(
                `discord: gateway startup stalled; backing off ${Math.round(delayMs / 1000)}s before retry (attempt ${backoffAttempt}/${STARTUP_MAX_BACKOFF_ATTEMPTS})`,
              ),
            );
            pushStatus({
              connected: false,
              lastEventAt: stuckAt,
              lastDisconnect: {
                at: stuckAt,
                error: "startup-reconnect-timeout",
              },
            });

            await new Promise<void>((resolve) => {
              const t = setTimeout(resolve, delayMs);
              t.unref?.();
              params.abortSignal?.addEventListener("abort", () => {
                clearTimeout(t);
                resolve();
              }, { once: true });
            });

            if (lifecycleStopping || params.abortSignal?.aborted) {
              return;
            }

            clearResumeState();
            gateway?.disconnect();
            gateway?.connect(false);

            const backoffReady = await waitForDiscordGatewayReady({
              gateway,
              abortSignal: params.abortSignal,
              timeoutMs: DISCORD_GATEWAY_READY_TIMEOUT_MS,
              beforePoll: drainPendingGatewayErrors,
            });

            if (backoffReady === "stopped" || lifecycleStopping) {
              return;
            }
            if (backoffReady !== "timeout") {
              startupRecovered = true;
              break;
            }
          }

          if (!startupRecovered && !lifecycleStopping) {
            const error = new Error(
              `discord gateway did not reach READY after ${STARTUP_MAX_BACKOFF_ATTEMPTS + 2} startup attempts`,
            );
            const startupFailureAt = Date.now();
            pushStatus({
              connected: false,
              lastEventAt: startupFailureAt,
              lastDisconnect: {
                at: startupFailureAt,
                error: "startup-reconnect-timeout",
              },
              lastError: error.message,
            });
            throw error;
          }
        }
      }
    }

    // If the gateway is already connected when the lifecycle starts (or becomes
    // connected during the startup readiness guard), push the initial connected
    // status now. Guard against lifecycleStopping: if the abortSignal was
    // already aborted, onAbort() ran synchronously above and pushed connected:
    // false, so don't contradict it with a spurious connected: true.
    if (gateway?.isConnected && !lifecycleStopping) {
      const at = Date.now();
      pushStatus({
        ...createConnectedChannelStatusPatch(at),
        lastDisconnect: null,
      });
    }

    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            emitter: gatewayEmitter,
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: params.abortSignal,
      onGatewayError: logGatewayError,
      shouldStopOnError: shouldStopOnGatewayError,
      registerForceStop: (forceStop) => {
        forceStopHandler = forceStop;
        if (queuedForceStopError !== undefined) {
          const queued = queuedForceStopError;
          queuedForceStopError = undefined;
          forceStop(queued);
        }
      },
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    lifecycleStopping = true;
    params.releaseEarlyGatewayErrorGuard?.();
    unregisterGateway(params.accountId);
    stopGatewayLogging();
    reconnectStallWatchdog.stop();
    clearHelloWatch();
    gatewayEmitter?.removeListener("debug", onGatewayDebug);
    params.abortSignal?.removeEventListener("abort", onAbort);
    if (params.voiceManager) {
      await params.voiceManager.destroy();
      params.voiceManagerRef.current = null;
    }
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.stop();
    }
    params.threadBindings.stop();
  }
}
