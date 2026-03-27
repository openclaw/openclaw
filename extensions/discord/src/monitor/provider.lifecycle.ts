import type { Client } from "@buape/carbon";
import type { GatewayPlugin } from "@buape/carbon/gateway";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import type { DiscordGatewayEvent, DiscordGatewaySupervisor } from "./gateway-supervisor.js";
import type { DiscordMonitorStatusSink } from "./status.js";

// ---------------------------------------------------------------------------
// Reconnect controller — inlined (was incorrectly split into a non-existent
// provider.lifecycle.reconnect.js by a concurrent change).
// ---------------------------------------------------------------------------

const STARTUP_READY_TIMEOUT_MS = 15_000;
const RECONNECT_WATCHDOG_TIMEOUT_MS = 5 * 60_000;
const SOCKET_DRAIN_TIMEOUT_MS = 5_000;

type ReconnectController = {
  onGatewayDebug: (message: string) => void;
  ensureStartupReady: () => Promise<void>;
  registerForceStop: (callback: (err?: Error) => void) => void;
  dispose: () => void;
};

function createDiscordGatewayReconnectController(params: {
  accountId: string;
  gateway: GatewayPlugin | undefined;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  pushStatus: (patch: Parameters<DiscordMonitorStatusSink>[0]) => void;
  isLifecycleStopping: () => boolean;
  drainPendingGatewayErrors: () => "continue" | "stop";
}): ReconnectController {
  const { gateway, runtime, abortSignal, pushStatus, isLifecycleStopping } = params;

  // ---------- abort / status tracking ----------
  let disposed = false;
  let forceStopCallback: ((err?: Error) => void) | undefined;

  const onAbort = () => {
    pushStatus({ connected: false, lastDisconnect: { at: Date.now() } });
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      // Already aborted before lifecycle started — push false immediately.
      onAbort();
    } else {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  // Push connected: true if gateway is already up at lifecycle start
  // (and the lifecycle hasn't already been aborted).
  if (gateway?.isConnected && !isLifecycleStopping()) {
    pushStatus({ connected: true, lastDisconnect: null, lastConnectedAt: Date.now() });
  }

  // ---------- startup READY watchdog ----------
  // Tracks whether we have seen a successful connect (READY/RESUMED) since
  // the last "WebSocket connection opened" debug event during startup.
  let pendingStartupResolve: (() => void) | undefined;
  let pendingStartupReject: ((err: Error) => void) | undefined;
  let startupReadyTimer: ReturnType<typeof setTimeout> | undefined;
  let startupForced = false; // true after we've already forced one reconnect

  // Tracks HELLO-stall reconnect attempts within a single disconnect episode.
  // Reset when a reconnect succeeds (isConnected becomes true).
  let helloStallAttempts = 0;

  // Reconnect watchdog — fires if the gateway doesn't re-open within
  // RECONNECT_WATCHDOG_TIMEOUT_MS after a close event.
  let reconnectWatchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const clearReconnectWatchdog = () => {
    if (reconnectWatchdogTimer !== undefined) {
      clearTimeout(reconnectWatchdogTimer);
      reconnectWatchdogTimer = undefined;
    }
  };

  const armReconnectWatchdog = () => {
    clearReconnectWatchdog();
    reconnectWatchdogTimer = setTimeout(() => {
      if (disposed || isLifecycleStopping()) return;
      const err = new Error(
        `discord: reconnect watchdog timeout — gateway did not reopen within ${RECONNECT_WATCHDOG_TIMEOUT_MS}ms`,
      );
      runtime.error?.(danger(err.message));
      forceStopCallback?.(err);
    }, RECONNECT_WATCHDOG_TIMEOUT_MS);
  };

  const clearStartupTimer = () => {
    if (startupReadyTimer !== undefined) {
      clearTimeout(startupReadyTimer);
      startupReadyTimer = undefined;
    }
  };

  // Clears the stale resume state so Carbon won't try to RESUME with a dead
  // session after a forced fresh-identify reconnect.
  const clearGatewaySessionState = () => {
    const gw = gateway as unknown as {
      state?: {
        sessionId?: string | null;
        resumeGatewayUrl?: string | null;
        sequence?: number | null;
      };
      sequence?: number | null;
    };
    if (gw.state) {
      gw.state.sessionId = null;
      gw.state.resumeGatewayUrl = null;
      gw.state.sequence = null;
    }
    gw.sequence = null;
  };

  // Attempt a forced fresh reconnect (no RESUME): disconnect the current
  // socket, wait for it to drain, clear resume state, then reconnect with
  // resume=false.
  const forceFreshReconnect = async (reason: string): Promise<void> => {
    if (!gateway || isLifecycleStopping()) return;

    runtime.error?.(danger(reason));
    clearStartupTimer();

    const ws = (
      gateway as unknown as {
        ws?: {
          terminate?: () => void;
          on?: (event: string, listener: (...args: any[]) => void) => void;
          off?: (event: string, listener: (...args: any[]) => void) => void;
        };
      }
    ).ws;

    // Ask the gateway to disconnect cleanly first.
    gateway.disconnect();

    // Wait for the underlying WebSocket to actually close before reconnecting,
    // to avoid opening a parallel socket. We poll for the `close` event on
    // the raw ws, with a timeout.
    await new Promise<void>((resolve, reject) => {
      if (!ws) {
        resolve();
        return;
      }

      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const onClose = () => {
        clearTimeout(drainTimer);
        resolve();
      };
      ws.on?.("close", onClose);

      drainTimer = setTimeout(async () => {
        ws.off?.("close", onClose);

        // Try a forced terminate before giving up entirely.
        if (typeof ws.terminate === "function") {
          runtime.error?.(
            danger(
              `discord: gateway socket did not close within ${SOCKET_DRAIN_TIMEOUT_MS}ms, attempting forced terminate before giving up`,
            ),
          );
          ws.terminate();

          // One more short wait after terminate.
          await new Promise<void>((res2) => {
            let terminateTimer: ReturnType<typeof setTimeout> | undefined;
            const onClose2 = () => {
              clearTimeout(terminateTimer);
              res2();
            };
            ws.on?.("close", onClose2);
            terminateTimer = setTimeout(() => {
              ws.off?.("close", onClose2);
              res2();
            }, SOCKET_DRAIN_TIMEOUT_MS);
          });

          // Check again — if still not closed, we have to bail.
          // (We track this via the `close` event: if onClose2 fired, we'd
          // have resolved above. If we reach here it timed out twice.)
          reject(
            new Error(
              `discord gateway socket did not close within ${SOCKET_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
          runtime.error?.(
            danger(
              `discord: gateway socket did not close within ${SOCKET_DRAIN_TIMEOUT_MS}ms, force-stopping instead of opening a parallel socket`,
            ),
          );
        } else {
          reject(
            new Error(
              `discord gateway socket did not close within ${SOCKET_DRAIN_TIMEOUT_MS}ms before reconnect`,
            ),
          );
          runtime.error?.(
            danger(
              `discord: gateway socket did not close within ${SOCKET_DRAIN_TIMEOUT_MS}ms, force-stopping instead of opening a parallel socket`,
            ),
          );
        }
      }, SOCKET_DRAIN_TIMEOUT_MS);
    });

    if (isLifecycleStopping()) return;

    clearGatewaySessionState();
    gateway.connect(false);
  };

  // ---------- debug event handler (drives READY / watchdog logic) ----------
  const onGatewayDebug = (message: string): void => {
    if (disposed) return;

    if (message.includes("WebSocket connection opened")) {
      clearReconnectWatchdog();

      // After an open, track whether we reached READY/RESUMED within the
      // timeout window. Only relevant while ensureStartupReady is pending OR
      // during the live watchdog phase.
      if (!isLifecycleStopping()) {
        const wasConnected = gateway?.isConnected ?? false;

        clearStartupTimer();
        startupReadyTimer = setTimeout(async () => {
          startupReadyTimer = undefined;
          if (disposed || isLifecycleStopping()) return;
          // If gateway is now connected, we made it — nothing to do.
          if (gateway?.isConnected) {
            helloStallAttempts = 0;
            return;
          }

          helloStallAttempts++;

          if (!startupForced) {
            // First timeout during the very first connect (startup phase).
            // Reject ensureStartupReady so the lifecycle can force a reconnect.
            const err = new Error(
              `discord: gateway was not ready after ${STARTUP_READY_TIMEOUT_MS}ms — forcing fresh identify`,
            );
            pendingStartupReject?.(err);
            return;
          }

          // Second timeout after a forced reconnect — give up.
          const err = new Error(
            `discord gateway did not reach READY within ${STARTUP_READY_TIMEOUT_MS}ms after a forced reconnect`,
          );
          forceStopCallback?.(err);
        }, STARTUP_READY_TIMEOUT_MS);

        // If this open came after the gateway was connected (i.e. a reconnect
        // after a drop), reset the HELLO stall counter only when we were
        // previously successfully connected.
        if (wasConnected) {
          helloStallAttempts = 0;
        }
      }
    }

    if (message.includes("WebSocket connection closed")) {
      clearStartupTimer();
      if (!isLifecycleStopping()) {
        armReconnectWatchdog();
        pushStatus({ connected: false, lastDisconnect: { at: Date.now() } });
      }
    }

    // Carbon emits this after READY or RESUMED
    if (
      message.includes("WebSocket connection opened") === false &&
      gateway?.isConnected &&
      !isLifecycleStopping()
    ) {
      if (!startupForced && pendingStartupResolve) {
        // Startup succeeded normally.
        clearStartupTimer();
        pendingStartupResolve();
        return;
      }
      pushStatus({ connected: true, lastDisconnect: null, lastConnectedAt: Date.now() });
      helloStallAttempts = 0;
    }
  };

  // ensureStartupReady resolves once the gateway has confirmed it is READY.
  // If the gateway is already connected at lifecycle start, it resolves
  // immediately. Otherwise it waits for the first READY/RESUMED signal (via
  // onGatewayDebug). On HELLO timeout it forces a fresh reconnect; if that
  // also times out the lifecycle is force-stopped.
  const ensureStartupReady = async (): Promise<void> => {
    if (isLifecycleStopping()) return;

    // If already connected at lifecycle start, nothing to wait for.
    if (gateway?.isConnected) return;

    // Wait for startup ready (resolved by onGatewayDebug when isConnected).
    await new Promise<void>((resolve, reject) => {
      pendingStartupResolve = resolve;
      pendingStartupReject = reject;

      // Kick off the initial HELLO timeout.
      clearStartupTimer();
      startupReadyTimer = setTimeout(async () => {
        startupReadyTimer = undefined;
        if (disposed || isLifecycleStopping()) {
          resolve();
          return;
        }
        if (gateway?.isConnected) {
          resolve();
          return;
        }
        // Drain any gateway errors that arrived while we were waiting, before
        // attempting the forced reconnect.
        if (params.drainPendingGatewayErrors() === "stop") {
          resolve();
          return;
        }

        // Force a fresh reconnect and wait for READY a second time.
        startupForced = true;
        try {
          await forceFreshReconnect(
            `discord: gateway was not ready after ${STARTUP_READY_TIMEOUT_MS}ms — forcing fresh identify`,
          );
        } catch (err) {
          reject(err);
          return;
        }

        if (isLifecycleStopping()) {
          resolve();
          return;
        }

        // Now wait for READY with a second timeout.
        clearStartupTimer();
        startupReadyTimer = setTimeout(() => {
          startupReadyTimer = undefined;
          if (disposed || isLifecycleStopping()) {
            resolve();
            return;
          }
          reject(
            new Error(
              `discord gateway did not reach READY within ${STARTUP_READY_TIMEOUT_MS}ms after a forced reconnect`,
            ),
          );
        }, STARTUP_READY_TIMEOUT_MS);
      }, STARTUP_READY_TIMEOUT_MS);
    });

    pendingStartupResolve = undefined;
    pendingStartupReject = undefined;
  };

  const registerForceStop = (callback: (err?: Error) => void): void => {
    forceStopCallback = callback;
  };

  const dispose = (): void => {
    disposed = true;
    clearStartupTimer();
    clearReconnectWatchdog();
    abortSignal?.removeEventListener("abort", onAbort);
    forceStopCallback = undefined;
    pendingStartupResolve = undefined;
    pendingStartupReject = undefined;
  };

  return { onGatewayDebug, ensureStartupReady, registerForceStop, dispose };
}

// ---------------------------------------------------------------------------
// Public lifecycle entry point
// ---------------------------------------------------------------------------

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  /** Carbon Client — used by provider.ts; gateway is derived via getPlugin. */
  client?: Client;
  /** GatewayPlugin directly — used by tests. Takes precedence over client. */
  gateway?: MutableDiscordGateway;
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
  const gateway: GatewayPlugin | undefined =
    params.gateway ?? params.client?.getPlugin<GatewayPlugin>("gateway") ?? undefined;
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = params.gatewaySupervisor.emitter ?? getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime,
  });
  let lifecycleStopping = false;

  const pushStatus = (patch: Parameters<DiscordMonitorStatusSink>[0]) => {
    params.statusSink?.(patch);
  };
  const reconnectController = createDiscordGatewayReconnectController({
    accountId: params.accountId,
    gateway,
    runtime: params.runtime,
    abortSignal: params.abortSignal,
    pushStatus,
    isLifecycleStopping: () => lifecycleStopping,
    drainPendingGatewayErrors: () => drainPendingGatewayErrors(),
  });
  const onGatewayDebug = reconnectController.onGatewayDebug;
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
    // When we deliberately set maxAttempts=0 and disconnected (health-monitor
    // stale-socket restart), Carbon fires "Max reconnect attempts (0)". This
    // is expected — log at info instead of error to avoid false alarms.
    if (lifecycleStopping && event.type === "reconnect-exhausted") {
      params.runtime.log?.(
        `discord: ignoring expected reconnect-exhausted during shutdown: ${event.message}`,
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
      // Don't throw for expected shutdown events — intentional disconnect
      // (reconnect-exhausted with maxAttempts=0) and disallowed-intents are
      // both handled without crashing the provider.
      if (
        event.type === "disallowed-intents" ||
        (lifecycleStopping && event.type === "reconnect-exhausted")
      ) {
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

    await reconnectController.ensureStartupReady();

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
      registerForceStop: (callback) => {
        reconnectController.registerForceStop((err: any) => {
          // Mark before the disconnect so the ensuing "Max reconnect attempts (0)"
          // is classified as reconnect-aborted, not reconnect-exhausted.
          params.gatewaySupervisor.markIntentionalAbort();
          callback(err ?? undefined);
        });
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
    reconnectController.dispose();
    gatewayEmitter?.removeListener("debug", onGatewayDebug);
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
