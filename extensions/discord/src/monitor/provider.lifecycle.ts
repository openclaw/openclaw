import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createTransportActivityStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { asDateTimestampMs, parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose, sleepWithAbort, warn } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { isFatalGatewayCloseCode } from "../internal/gateway-close-codes.js";
import { GatewayCloseCodes } from "../internal/gateway.js";
import { setDiscordTranscriptsVoiceManager } from "../voice/transcripts-source.js";
import type { DiscordVoiceManager } from "../voice/voice-runtime.js";
import {
  DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
  type MutableDiscordGateway,
} from "./gateway-handle.js";
import { registerGateway, unregisterGateway } from "./gateway-registry.js";
import {
  DiscordGatewayLifecycleError,
  type DiscordGatewayEvent,
  type DiscordGatewaySupervisor,
} from "./gateway-supervisor.js";
import { createDiscordReadyStatusPatch, type DiscordMonitorStatusSink } from "./status.js";

const DEFAULT_DISCORD_GATEWAY_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS = 30_000;
const MAX_DISCORD_GATEWAY_READY_TIMEOUT_MS = 120_000;
const DISCORD_GATEWAY_READY_TIMEOUT_ENV = "OPENCLAW_DISCORD_READY_TIMEOUT_MS";
const DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_ENV = "OPENCLAW_DISCORD_RUNTIME_READY_TIMEOUT_MS";
const DISCORD_GATEWAY_READY_POLL_MS = 250;
const DISCORD_GATEWAY_READY_RETRY_BACKOFF_MS = 2_000;
const DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS = 30_000;

const INFO_DEBUG_MARKERS = [
  "Gateway websocket closed",
  "Gateway reconnect scheduled in",
  "Gateway forcing fresh IDENTIFY after",
];

type GatewayReadyWaitResult = "ready" | "stopped" | "timeout";

function createGatewayNotReadyStatusPatch(
  at: number,
  reason: "runtime-not-ready" | "startup-not-ready",
): Parameters<DiscordMonitorStatusSink>[0] {
  return {
    connected: false,
    lifecycle: "recovering",
    lastEventAt: at,
    lastDisconnect: { at, error: reason },
    lastError: reason,
  };
}

function normalizeGatewayReadyTimeoutMs(value: unknown): number | undefined {
  const numeric = parseStrictPositiveInteger(value);
  if (numeric === undefined) {
    return undefined;
  }
  return Math.min(numeric, MAX_DISCORD_GATEWAY_READY_TIMEOUT_MS);
}

function parseGatewayCloseCode(message: string): number | undefined {
  const match = /Gateway websocket closed:\s*(\d{3,5})/.exec(message);
  if (!match?.[1]) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

function resolveTransportActivityAt(event: unknown): number {
  const at = (event as { at?: unknown } | undefined)?.at;
  const timestampMs = asDateTimestampMs(at);
  return timestampMs !== undefined && timestampMs >= 0 ? timestampMs : Date.now();
}

export async function runDiscordGatewayLifecycle(params: {
  accountId: string;
  gateway: MutableDiscordGateway;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  isDisallowedIntentsError: (err: unknown) => boolean;
  voiceManager: DiscordVoiceManager | null;
  voiceManagerRef: { current: DiscordVoiceManager | null };
  threadBindings: { stop: () => void | Promise<void> };
  gatewaySupervisor: DiscordGatewaySupervisor;
  statusSink?: DiscordMonitorStatusSink;
}) {
  const gateway = params.gateway;
  const gatewayReadyAtLifecycleStart = gateway.isConnected;
  registerGateway(params.accountId, gateway);
  const gatewayEmitter = params.gatewaySupervisor.emitter;
  const loggingRuntime = params.runtime;
  let lifecycleStopping = false;

  const pushStatus = (patch: Parameters<DiscordMonitorStatusSink>[0]) => {
    params.statusSink?.(patch);
  };
  const gatewayReadyTimeoutMs =
    normalizeGatewayReadyTimeoutMs(process.env[DISCORD_GATEWAY_READY_TIMEOUT_ENV]) ??
    DEFAULT_DISCORD_GATEWAY_READY_TIMEOUT_MS;
  const gatewayRuntimeReadyTimeoutMs =
    normalizeGatewayReadyTimeoutMs(process.env[DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_ENV]) ??
    DEFAULT_DISCORD_GATEWAY_RUNTIME_READY_TIMEOUT_MS;
  const { abortSignal: observerAbortSignal, runtime: observerRuntime } = params;
  let forceStopHandler: ((err: unknown) => void) | undefined;
  let queuedForceStopError: unknown;
  let readyPollId: ReturnType<typeof setInterval> | undefined;
  let readyTimeoutId: ReturnType<typeof setTimeout> | undefined;

  const shouldStop = () => observerAbortSignal?.aborted || lifecycleStopping;
  const clearReadyWatch = () => {
    if (readyPollId) {
      clearInterval(readyPollId);
      readyPollId = undefined;
    }
    if (readyTimeoutId) {
      clearTimeout(readyTimeoutId);
      readyTimeoutId = undefined;
    }
  };
  const triggerForceStop = (err: unknown) => {
    if (forceStopHandler) {
      forceStopHandler(err);
      return;
    }
    queuedForceStopError = err;
  };
  const startReadyWatch = () => {
    clearReadyWatch();
    const pollConnected = () => {
      if (shouldStop()) {
        clearReadyWatch();
        return;
      }
      if (!gateway.isConnected) {
        return;
      }
      clearReadyWatch();
      pushStatus(createDiscordReadyStatusPatch(Date.now()));
    };

    pollConnected();
    if (!readyTimeoutId) {
      readyPollId = setInterval(pollConnected, DISCORD_GATEWAY_READY_POLL_MS);
      readyPollId.unref();
      readyTimeoutId = setTimeout(() => {
        clearReadyWatch();
        if (shouldStop() || gateway.isConnected) {
          return;
        }
        const at = Date.now();
        const error = new Error(
          `discord gateway opened but did not reach READY within ${gatewayRuntimeReadyTimeoutMs}ms`,
        );
        pushStatus(createGatewayNotReadyStatusPatch(at, "runtime-not-ready"));
        observerRuntime.error?.(danger(error.message));
        triggerForceStop(error);
      }, gatewayRuntimeReadyTimeoutMs);
      readyTimeoutId.unref();
    }
  };

  const onGatewayDebug = (msg: unknown) => {
    const logMessage = String(msg);
    logVerbose(`discord gateway: ${logMessage}`);
    if (INFO_DEBUG_MARKERS.some((marker) => logMessage.includes(marker))) {
      loggingRuntime.log?.(`discord gateway: ${logMessage}`);
    }
    if (shouldStop()) {
      return;
    }
    const at = Date.now();
    const message = String(msg);
    if (message.includes("Gateway websocket opened")) {
      pushStatus({ connected: false, lastEventAt: at });
      startReadyWatch();
      return;
    }
    if (message.includes("Gateway websocket closed")) {
      clearReadyWatch();
      const code = parseGatewayCloseCode(message);
      // Fatal gateway closes require operator repair. Keep the outer channel supervisor from
      // turning an invalid credential or configuration into an automatic restart loop.
      const terminalDisconnect =
        code !== undefined && isFatalGatewayCloseCode(code as GatewayCloseCodes);
      pushStatus({
        connected: false,
        lifecycle: terminalDisconnect ? "blocked" : "recovering",
        ...(terminalDisconnect ? { terminalDisconnect: true, lastError: message } : {}),
        lastEventAt: at,
        lastDisconnect: {
          at,
          ...(code !== undefined ? { status: code } : {}),
        },
      });
      return;
    }
    if (message.includes("Gateway reconnect scheduled in")) {
      clearReadyWatch();
      pushStatus({
        connected: false,
        lifecycle: "recovering",
        lastEventAt: at,
        lastError: message,
      });
    }
  };

  const waitForGatewayReady = async (): Promise<void> => {
    const { abortSignal, runtime } = params;
    const waitUntilReady = async (): Promise<GatewayReadyWaitResult> => {
      // The READY budget is consumed by setTimeout polls on the monotonic clock;
      // the deadline must live there too, or a wall-clock step (NTP correction,
      // VM resume) inflates or shrinks the wait past its configured bound.
      const deadlineAt = performance.now() + gatewayReadyTimeoutMs;
      for (;;) {
        if (abortSignal?.aborted) {
          return "stopped";
        }
        if ((await Promise.resolve(drainPendingGatewayErrors())) === "stop") {
          return "stopped";
        }
        if (gateway.isConnected) {
          const at = Date.now();
          pushStatus(createDiscordReadyStatusPatch(at));
          return "ready";
        }
        if (performance.now() >= deadlineAt) {
          return "timeout";
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, DISCORD_GATEWAY_READY_POLL_MS).unref();
        });
      }
    };

    let attempt = 0;
    for (;;) {
      if (abortSignal?.aborted) {
        return;
      }
      const result = await waitUntilReady();
      if (result !== "timeout") {
        return;
      }
      attempt += 1;
      const restartAt = Date.now();
      runtime.error?.(
        danger(
          `discord: gateway READY wait timed out after ${gatewayReadyTimeoutMs}ms; reconnecting with backoff (attempt ${attempt})`,
        ),
      );
      pushStatus(createGatewayNotReadyStatusPatch(restartAt, "startup-not-ready"));
      clearReadyWatch();
      // Keep the pre-reconnect yield before rechecking cancellation.
      await Promise.resolve();
      if (abortSignal?.aborted) {
        return;
      }
      // Gateway owns replacement callbacks; ws bounds the old socket's asynchronous close.
      gateway.disconnect();
      if (abortSignal?.aborted) {
        return;
      }
      gateway.connect(false);
      try {
        await sleepWithAbort(DISCORD_GATEWAY_READY_RETRY_BACKOFF_MS, abortSignal, {
          ref: false,
        });
      } catch {
        // Abort is normal lifecycle shutdown; do not enter another reconnect attempt.
        return;
      }
    }
  };
  const onGatewayWarning = (warning: unknown) => {
    const message = `discord gateway warning: ${String(warning)}`;
    logVerbose(message);
    loggingRuntime.log?.(warn(message));
  };

  gatewayEmitter.on("debug", onGatewayDebug);
  gatewayEmitter.on("warning", onGatewayWarning);
  let lastTransportActivityStatusAt: number | undefined;
  const onGatewayTransportActivity = (event: unknown) => {
    if (lifecycleStopping || params.abortSignal?.aborted) {
      return;
    }
    const at = resolveTransportActivityAt(event);
    if (
      lastTransportActivityStatusAt !== undefined &&
      at - lastTransportActivityStatusAt < DISCORD_GATEWAY_TRANSPORT_ACTIVITY_STATUS_MIN_INTERVAL_MS
    ) {
      return;
    }
    lastTransportActivityStatusAt = at;
    pushStatus(createTransportActivityStatusPatch(at));
  };
  gatewayEmitter.on(DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT, onGatewayTransportActivity);

  let sawDisallowedIntents = false;
  const handleGatewayEvent = (event: DiscordGatewayEvent): "continue" | "stop" => {
    if (params.abortSignal?.aborted && event.type === "reconnect-exhausted") {
      lifecycleStopping = true;
      params.runtime.log?.(
        `discord: treating reconnect-exhausted during expected shutdown as clean: ${event.message}`,
      );
      return "continue";
    }
    if (event.type === "disallowed-intents") {
      lifecycleStopping = true;
      sawDisallowedIntents = true;
      params.runtime.error?.(
        danger(
          "discord: gateway closed with code 4014 (missing privileged gateway intents). Enable the required intents in the Discord Developer Portal or disable them in config.",
        ),
      );
      return "stop";
    }
    if (event.shouldStopLifecycle) {
      lifecycleStopping = true;
    }
    params.runtime.error?.(
      danger(
        event.shouldStopLifecycle
          ? `discord gateway ${event.type}: ${event.message}`
          : `discord gateway error: ${event.message}`,
      ),
    );
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
      throw new DiscordGatewayLifecycleError(event);
    });
  try {
    // Drain gateway errors emitted before lifecycle listeners were attached.
    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    if (gatewayReadyAtLifecycleStart && params.voiceManager) {
      // READY may precede lazy voice-listener registration. Reconcile only after lifecycle
      // ownership begins so every startup failure still destroys the manager in `finally`.
      void params.voiceManager
        .autoJoin()
        .catch((err: unknown) =>
          params.runtime.error?.(
            danger(`discord voice: autoJoin failed: ${formatErrorMessage(err)}`),
          ),
        );
    }

    await waitForGatewayReady();

    if (drainPendingGatewayErrors() === "stop") {
      return;
    }

    const { abortSignal, gatewaySupervisor } = params;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          gateway.disconnect();
        } finally {
          // Disconnect can emit a final error; retain its listener until it returns.
          abortSignal?.removeEventListener("abort", onAbort);
          gatewaySupervisor.detachLifecycle();
          settle();
        }
      };
      const finishReject = (err: unknown) => {
        finish(() => reject(toErrorObject(err, "Non-Error rejection")));
      };
      const onAbort = () => finish(resolve);
      const onGatewayEvent = (event: DiscordGatewayEvent) => {
        if (handleGatewayEvent(event) === "stop") {
          finishReject(new DiscordGatewayLifecycleError(event));
        }
      };
      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      gatewaySupervisor.attachLifecycle(onGatewayEvent);
      forceStopHandler = finishReject;
      if (queuedForceStopError !== undefined) {
        const err = queuedForceStopError;
        queuedForceStopError = undefined;
        finishReject(err);
      }
    });
  } catch (err) {
    if (!sawDisallowedIntents && !params.isDisallowedIntentsError(err)) {
      throw err;
    }
  } finally {
    try {
      lifecycleStopping = true;
      params.gatewaySupervisor.detachLifecycle();
      unregisterGateway(params.accountId);
      gatewayEmitter.removeListener("warning", onGatewayWarning);
      clearReadyWatch();
      forceStopHandler = undefined;
      queuedForceStopError = undefined;
      gatewayEmitter.removeListener("debug", onGatewayDebug);
      gatewayEmitter.removeListener(
        DISCORD_GATEWAY_TRANSPORT_ACTIVITY_EVENT,
        onGatewayTransportActivity,
      );
      if (params.voiceManager) {
        await params.voiceManager.destroy();
        setDiscordTranscriptsVoiceManager({
          accountId: params.accountId,
          manager: null,
          expectedManager: params.voiceManager,
        });
        params.voiceManagerRef.current = null;
      }
    } finally {
      await params.threadBindings.stop();
    }
  }
}
