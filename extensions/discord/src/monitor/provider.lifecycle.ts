import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { attachDiscordGatewayLogging } from "../gateway-logging.js";
import { getDiscordGatewayEmitter, waitForDiscordGatewayStop } from "../monitor.gateway.js";
import type { DiscordVoiceManager } from "../voice/manager.js";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import type { DiscordGatewayEvent, DiscordGatewaySupervisor } from "./gateway-supervisor.js";
import { createDiscordGatewayReconnectController } from "./provider.lifecycle.reconnect.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type ExecApprovalsHandler = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
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
  const gateway = params.gateway;
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

  // Transition the supervisor to teardown phase *before* the reconnect
  // controller's own onAbort handler calls gateway.disconnect().  This
  // listener is registered before createDiscordGatewayReconnectController so
  // it fires first (DOM-style listener ordering), ensuring the synchronous
  // "Max reconnect attempts (0)" error emitted by @buape/carbon during
  // disconnect is suppressed by the supervisor's teardown logic instead of
  // being routed to the lifecycle handler and crashing the process.
  // Fixes #54931 and #54894.
  let earlyDetachOnAbort: (() => void) | undefined;
  if (params.abortSignal && !params.abortSignal.aborted) {
    earlyDetachOnAbort = () => {
      params.gatewaySupervisor.detachLifecycle();
    };
    params.abortSignal.addEventListener("abort", earlyDetachOnAbort, { once: true });
  } else if (params.abortSignal?.aborted) {
    params.gatewaySupervisor.detachLifecycle();
  }

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
      registerForceStop: reconnectController.registerForceStop,
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    lifecycleStopping = true;
    // Remove the early-detach abort listener if the lifecycle completed
    // without being aborted, preventing a stale listener from leaking
    // references or firing after teardown (CWE-772).
    if (earlyDetachOnAbort && params.abortSignal && !params.abortSignal.aborted) {
      params.abortSignal.removeEventListener("abort", earlyDetachOnAbort);
    }
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
