import { createArmableStallWatchdog } from "../../../../src/channels/transport/stall-watchdog.js";
import { createConnectedChannelStatusPatch } from "../../../../src/gateway/channel-status-patches.js";
import { danger } from "../../../../src/globals.js";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
async function runDiscordGatewayLifecycle(params) {
  const HELLO_TIMEOUT_MS = 3e4;
  const HELLO_CONNECTED_POLL_MS = 250;
  const MAX_CONSECUTIVE_HELLO_STALLS = 3;
  const RECONNECT_STALL_TIMEOUT_MS = 5 * 6e4;
  const gateway = params.client.getPlugin("gateway");
  if (gateway) {
    registerGateway(params.accountId, gateway);
  }
  const gatewayEmitter = getDiscordGatewayEmitter(gateway);
  const stopGatewayLogging = attachDiscordGatewayLogging({
    emitter: gatewayEmitter,
    runtime: params.runtime
  });
  let lifecycleStopping = false;
  let forceStopHandler;
  let queuedForceStopError;
  const pushStatus = (patch) => {
    params.statusSink?.(patch);
  };
  const triggerForceStop = (err) => {
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
        `discord reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms`
      );
      pushStatus({
        connected: false,
        lastEventAt: at,
        lastDisconnect: {
          at,
          error: error.message
        },
        lastError: error.message
      });
      params.runtime.error?.(
        danger(
          `discord: reconnect watchdog timeout after ${RECONNECT_STALL_TIMEOUT_MS}ms; force-stopping monitor task`
        )
      );
      triggerForceStop(error);
    }
  });
  const onAbort = () => {
    lifecycleStopping = true;
    reconnectStallWatchdog.disarm();
    const at = Date.now();
    pushStatus({ connected: false, lastEventAt: at });
    if (!gateway) {
      return;
    }
    gatewayEmitter?.once("error", () => {
    });
    gateway.options.reconnect = { maxAttempts: 0 };
    gateway.disconnect();
  };
  if (params.abortSignal?.aborted) {
    onAbort();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }
  let helloTimeoutId;
  let helloConnectedPollId;
  let consecutiveHelloStalls = 0;
  const clearHelloWatch = () => {
    if (helloTimeoutId) {
      clearTimeout(helloTimeoutId);
      helloTimeoutId = void 0;
    }
    if (helloConnectedPollId) {
      clearInterval(helloConnectedPollId);
      helloConnectedPollId = void 0;
    }
  };
  const resetHelloStallCounter = () => {
    consecutiveHelloStalls = 0;
  };
  const parseGatewayCloseCode = (message) => {
    const match = /code\s+(\d{3,5})/i.exec(message);
    if (!match?.[1]) {
      return void 0;
    }
    const code = Number.parseInt(match[1], 10);
    return Number.isFinite(code) ? code : void 0;
  };
  const clearResumeState = () => {
    const mutableGateway = gateway;
    if (!mutableGateway?.state) {
      return;
    }
    mutableGateway.state.sessionId = null;
    mutableGateway.state.resumeGatewayUrl = null;
    mutableGateway.state.sequence = null;
    mutableGateway.sequence = null;
  };
  const onGatewayDebug = (msg) => {
    const message = String(msg);
    const at = Date.now();
    pushStatus({ lastEventAt: at });
    if (message.includes("WebSocket connection closed")) {
      if (gateway?.isConnected) {
        resetHelloStallCounter();
      }
      reconnectStallWatchdog.arm(at);
      pushStatus({
        connected: false,
        lastDisconnect: {
          at,
          status: parseGatewayCloseCode(message)
        }
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
        lastDisconnect: null
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
        lastDisconnect: null
      });
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = void 0;
      }
    }, HELLO_CONNECTED_POLL_MS);
    helloTimeoutId = setTimeout(() => {
      if (helloConnectedPollId) {
        clearInterval(helloConnectedPollId);
        helloConnectedPollId = void 0;
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
            error: "hello-timeout"
          }
        });
        params.runtime.log?.(
          danger(
            forceFreshIdentify ? `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); forcing fresh identify` : `connection stalled: no HELLO within ${HELLO_TIMEOUT_MS}ms (${consecutiveHelloStalls}/${MAX_CONSECUTIVE_HELLO_STALLS}); retrying resume`
          )
        );
        if (forceFreshIdentify) {
          clearResumeState();
          resetHelloStallCounter();
        }
        gateway?.disconnect();
        gateway?.connect(!forceFreshIdentify);
      }
      helloTimeoutId = void 0;
    }, HELLO_TIMEOUT_MS);
  };
  gatewayEmitter?.on("debug", onGatewayDebug);
  if (gateway?.isConnected && !lifecycleStopping) {
    const at = Date.now();
    pushStatus({
      ...createConnectedChannelStatusPatch(at),
      lastDisconnect: null
    });
  }
  let sawDisallowedIntents = false;
  const logGatewayError = (err) => {
    if (params.isDisallowedIntentsError(err)) {
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config."
        )
      );
      return;
    }
    params.runtime.error?.(danger(`discord gateway error: ${String(err)}`));
  };
  const shouldStopOnGatewayError = (err) => {
    const message = String(err);
    return message.includes("Max reconnect attempts") || message.includes("Fatal Gateway error") || params.isDisallowedIntentsError(err);
  };
  try {
    if (params.execApprovalsHandler) {
      await params.execApprovalsHandler.start();
    }
    const pendingGatewayErrors = params.pendingGatewayErrors ?? [];
    if (pendingGatewayErrors.length > 0) {
      const queuedErrors = [...pendingGatewayErrors];
      pendingGatewayErrors.length = 0;
      for (const err of queuedErrors) {
        logGatewayError(err);
        if (!shouldStopOnGatewayError(err)) {
          continue;
        }
        if (params.isDisallowedIntentsError(err)) {
          return;
        }
        throw err;
      }
    }
    await waitForDiscordGatewayStop({
      gateway: gateway ? {
        emitter: gatewayEmitter,
        disconnect: () => gateway.disconnect()
      } : void 0,
      abortSignal: params.abortSignal,
      onGatewayError: logGatewayError,
      shouldStopOnError: shouldStopOnGatewayError,
      registerForceStop: (forceStop) => {
        forceStopHandler = forceStop;
        if (queuedForceStopError !== void 0) {
          const queued = queuedForceStopError;
          queuedForceStopError = void 0;
          forceStop(queued);
        }
      }
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
export {
  runDiscordGatewayLifecycle
};
