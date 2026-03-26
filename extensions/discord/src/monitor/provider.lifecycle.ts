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
import type { DiscordGatewayEvent, DiscordGatewaySupervisor } from "./gateway-supervisor.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const DISCORD_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DISCORD_GATEWAY_READY_POLL_MS = 250;
const DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS = 5_000;
const DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS = 1_000;

type GatewaySocketListener = (...args: unknown[]) => void;

type DiscordGatewaySocket = {
  on: (event: "close" | "error", listener: GatewaySocketListener) => unknown;
  listeners: (event: "close" | "error") => GatewaySocketListener[];
  removeListener: (event: "close" | "error", listener: GatewaySocketListener) => unknown;
  terminate?: () => void;
};

type MutableGateway = GatewayPlugin & {
  state?: {
    sessionId?: string | null;
    resumeGatewayUrl?: string | null;
    sequence?: number | null;
  };
  sequence?: number | null;
  ws?: DiscordGatewaySocket | null;
};

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
  gatewaySupervisor: DiscordGatewaySupervisor;
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
  const gatewayEmitter = params.gatewaySupervisor.emitter ?? getDiscordGatewayEmitter(gateway);
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
    const mutableGateway = gateway as MutableGateway | undefined;
    if (!mutableGateway?.state) {
      return;
    }
    mutableGateway.state.sessionId = null;
    mutableGateway.state.resumeGatewayUrl = null;
    mutableGateway.state.sequence = null;
    mutableGateway.sequence = null;
  };
  const disconnectGatewaySocketWithoutAutoReconnect = async () => {
    if (!gateway) {
      return;
    }
    const mutableGateway = gateway as MutableGateway;
    const socket = mutableGateway.ws;
    if (!socket) {
      gateway.disconnect();
      return;
    }

    // Carbon reconnects from the socket close handler even for intentional
    // disconnects. Drop the current socket's close/error listeners so a forced
    // reconnect does not race the old socket's automatic resume path.
    for (const listener of socket.listeners("close")) {
      socket.removeListener("close", listener);
    }
    for (const listener of socket.listeners("error")) {
      socket.removeListener("error", listener);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let drainTimeout: ReturnType<typeof setTimeout> | undefined;
      let terminateCloseTimeout: ReturnType<typeof setTimeout> | undefined;
      const ignoreSocketError = () => {};
      const shouldStopWaiting = () => lifecycleStopping || params.abortSignal?.aborted;
      const clearPendingTimers = () => {
        if (drainTimeout) {
          clearTimeout(drainTimeout);
          drainTimeout = undefined;
        }
        if (terminateCloseTimeout) {
          clearTimeout(terminateCloseTimeout);
          terminateCloseTimeout = undefined;
        }
      };
      const cleanup = () => {
        clearPendingTimers();
        socket.removeListener("close", onClose);
        socket.removeListener("error", ignoreSocketError);
      };
      const onClose = () => {
        cleanup();
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      const resolveStoppedWait = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearPendingTimers();

        // Keep suppressing late ws errors until the socket actually closes.
        // The original Carbon listeners were removed above, and `terminate()`
        // can still asynchronously emit "error" before "close".
        resolve();
      };
      const rejectClose = (error: Error) => {
        if (shouldStopWaiting()) {
          resolveStoppedWait();
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        clearPendingTimers();

        // Keep suppressing late ws errors until the socket actually closes.
        // The original Carbon listeners were removed above, and `terminate()`
        // can still asynchronously emit "error" before "close".
        reject(error);
      };

      drainTimeout = setTimeout(() => {
        if (settled) {
          return;
        }
        if (shouldStopWaiting()) {
          resolveStoppedWait();
          return;
        }
        params.runtime.error?.(
          danger(
            `discord: gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect; attempting forced terminate before giving up`,
          ),
        );

        let terminateStarted = false;
        try {
          if (typeof socket.terminate === "function") {
            socket.terminate();
            terminateStarted = true;
          }
        } catch {
          // Best-effort only. If terminate fails, fail closed instead of
          // opening another socket on top of an unknown old one.
        }

        if (!terminateStarted) {
          params.runtime.error?.(
            danger(
              `discord: gateway socket did not expose a working terminate() after ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms; force-stopping instead of opening a parallel socket`,
            ),
          );
          rejectClose(
            new Error(
              `discord gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
          return;
        }

        terminateCloseTimeout = setTimeout(() => {
          if (settled) {
            return;
          }
          if (shouldStopWaiting()) {
            resolveStoppedWait();
            return;
          }
          params.runtime.error?.(
            danger(
              `discord: gateway socket did not close ${DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS}ms after forced terminate; force-stopping instead of opening a parallel socket`,
            ),
          );
          rejectClose(
            new Error(
              `discord gateway socket did not close within ${DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
        }, DISCORD_GATEWAY_FORCE_TERMINATE_CLOSE_TIMEOUT_MS);
        terminateCloseTimeout.unref?.();
      }, DISCORD_GATEWAY_DISCONNECT_DRAIN_TIMEOUT_MS);
      drainTimeout.unref?.();
      socket.on("error", ignoreSocketError);
      socket.on("close", onClose);
      gateway.disconnect();
    });
  };
  let reconnectInFlight: Promise<void> | undefined;
  const reconnectGateway = async (reconnectParams: {
    resume: boolean;
    forceFreshIdentify?: boolean;
  }) => {
    if (reconnectInFlight) {
      return await reconnectInFlight;
    }
    reconnectInFlight = (async () => {
      if (reconnectParams.forceFreshIdentify) {
        // Carbon still sends RESUME on HELLO when session state is populated,
        // even after connect(false). Clear cached session data first so this
        // path truly forces a fresh IDENTIFY.
        clearResumeState();
      }
      if (lifecycleStopping || params.abortSignal?.aborted) {
        return;
      }
      await disconnectGatewaySocketWithoutAutoReconnect();
      if (lifecycleStopping || params.abortSignal?.aborted) {
        return;
      }
      gateway?.connect(reconnectParams.resume);
    })().finally(() => {
      reconnectInFlight = undefined;
    });
    return await reconnectInFlight;
  };
  const reconnectGatewayFresh = async () => {
    await reconnectGateway({ resume: false, forceFreshIdentify: true });
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
      helloTimeoutId = undefined;
      void (async () => {
        try {
          if (helloConnectedPollId) {
            clearInterval(helloConnectedPollId);
            helloConnectedPollId = undefined;
          }
          if (sawConnected || gateway?.isConnected) {
            resetHelloStallCounter();
            return;
          }

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
            resetHelloStallCounter();
          }
          if (lifecycleStopping || params.abortSignal?.aborted) {
            return;
          }
          if (forceFreshIdentify) {
            await reconnectGatewayFresh();
            return;
          }
          await reconnectGateway({ resume: true });
        } catch (err) {
          params.runtime.error?.(
            danger(`discord: failed to restart stalled gateway socket: ${String(err)}`),
          );
          triggerForceStop(err);
        }
      })();
    }, HELLO_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);

  let sawDisallowedIntents = false;
  const handleGatewayEvent = (event: DiscordGatewayEvent): "continue" | "stop" => {
    if (event.type === "disallowed-intents") {
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
        ),
      );
      return "stop";
    }
    params.runtime.error?.(danger(`discord gateway error: ${event.message}`));
    return event.shouldStopLifecycle ? "stop" : "continue";
  };
  const drainPendingGatewayErrors = (): "continue" | "stop" =>
    params.gatewaySupervisor.drainPending((event) => {
      const decision = handleGatewayEvent(event);
      if (decision !== "stop") {
        return "continue";
      }
      if (event.type === "disallowed-intents") {
        return "stop";
      }
      throw event.err;
    });
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
        await reconnectGatewayFresh();
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
          const error = new Error(
            `discord gateway did not reach READY within ${DISCORD_GATEWAY_READY_TIMEOUT_MS}ms after a forced reconnect`,
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

    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    await waitForDiscordGatewayStop({
      gateway: gateway
        ? {
            disconnect: () => gateway.disconnect(),
          }
        : undefined,
      abortSignal: params.abortSignal,
      gatewaySupervisor: params.gatewaySupervisor,
      onGatewayEvent: handleGatewayEvent,
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
    params.gatewaySupervisor.detachLifecycle();
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
