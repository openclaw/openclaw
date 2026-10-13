import type { EventEmitter } from "node:events";
import { createSubsystemLogger, danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

type DiscordGatewayEventType = "disallowed-intents" | "fatal" | "other" | "reconnect-exhausted";

export type DiscordGatewayEvent = {
  type: DiscordGatewayEventType;
  err: unknown;
  message: string;
  shouldStopLifecycle: boolean;
};

export class DiscordGatewayLifecycleError extends Error {
  readonly eventType: DiscordGatewayEventType;

  constructor(event: Pick<DiscordGatewayEvent, "type" | "message" | "err">) {
    super(`discord gateway ${event.type}: ${event.message}`, {
      cause: event.err instanceof Error ? event.err : undefined,
    });
    this.name = "DiscordGatewayLifecycleError";
    this.eventType = event.type;
  }
}

export function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined {
  return (gateway as { emitter?: EventEmitter } | undefined)?.emitter;
}

export type DiscordGatewaySupervisor = {
  emitter?: EventEmitter;
  attachLifecycle: (handler: (event: DiscordGatewayEvent) => void) => void;
  detachLifecycle: () => void;
  drainPending: (
    handler: (event: DiscordGatewayEvent) => "continue" | "stop",
  ) => "continue" | "stop";
  dispose: () => void;
};

type GatewaySupervisorPhase = "active" | "buffering" | "disposed" | "teardown";

const discordGatewayLog = createSubsystemLogger("discord/gateway");
const discordGatewayLateErrorGuards = new WeakMap<EventEmitter, (err: unknown) => void>();

function removeDiscordGatewayLateErrorGuard(emitter: EventEmitter): void {
  const guard = discordGatewayLateErrorGuards.get(emitter);
  if (!guard) {
    return;
  }
  emitter.off("error", guard);
  discordGatewayLateErrorGuards.delete(emitter);
}

function ensureDiscordGatewayLateErrorGuard(emitter: EventEmitter): void {
  if (emitter.listenerCount("error") > 0) {
    return;
  }
  let logged = false;
  // Keep the emitter safe after its supervisor is gone without retaining the disposed runtime.
  // One diagnostic is enough for a retired socket; later errors must not grow retained state.
  const guard = (err: unknown) => {
    if (logged) {
      return;
    }
    logged = true;
    discordGatewayLog.error(
      `suppressed late gateway error after dispose: ${formatDiscordGatewayErrorMessage(err)}`,
    );
  };
  discordGatewayLateErrorGuards.set(emitter, guard);
  emitter.on("error", guard);
}

function readFirstStackFrame(err: Error): string | undefined {
  const stack = err.stack;
  if (!stack) {
    return undefined;
  }
  const frame = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find(Boolean);
  return frame ? frame.replace(/^at\s+/, "") : undefined;
}

function formatDiscordGatewayErrorMessage(err: unknown): string {
  const detail = formatErrorMessage(err);
  if (!(err instanceof Error)) {
    return detail;
  }
  if (err.message) {
    return err.name ? `${err.name}: ${detail}` : detail;
  }
  const firstFrame = readFirstStackFrame(err);
  if (firstFrame && detail === (err.name || "Error")) {
    return `${detail} @ ${firstFrame}`;
  }
  return detail;
}

function classifyDiscordGatewayEvent(params: {
  err: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
}): DiscordGatewayEvent {
  const message = formatDiscordGatewayErrorMessage(params.err);
  let type: DiscordGatewayEventType;
  if (params.isDisallowedIntentsError(params.err)) {
    type = "disallowed-intents";
  } else if (message.includes("Max reconnect attempts")) {
    type = "reconnect-exhausted";
  } else if (
    params.err instanceof TypeError ||
    message.includes("Fatal Gateway error") ||
    message.includes("Fatal gateway close code") ||
    message.includes("Gateway HELLO missing heartbeat") ||
    message.includes("Invalid gateway payload") ||
    message.includes("Gateway socket emitted an unknown error")
  ) {
    type = "fatal";
  } else {
    type = "other";
  }
  return {
    type,
    err: params.err,
    message,
    shouldStopLifecycle: type !== "other",
  };
}

export function createDiscordGatewaySupervisor(params: {
  gateway?: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
  runtime: RuntimeEnv;
}): DiscordGatewaySupervisor {
  const emitter = getDiscordGatewayEmitter(params.gateway);
  const pending: DiscordGatewayEvent[] = [];
  if (!emitter) {
    return {
      attachLifecycle: () => {},
      detachLifecycle: () => {},
      drainPending: () => "continue",
      dispose: () => {},
      emitter,
    };
  }

  let lifecycleHandler: ((event: DiscordGatewayEvent) => void) | undefined;
  let phase: GatewaySupervisorPhase = "buffering";
  let loggedLateError = false;
  const onGatewayError = (err: unknown) => {
    const event = classifyDiscordGatewayEvent({
      err,
      isDisallowedIntentsError: params.isDisallowedIntentsError,
    });
    switch (phase) {
      case "disposed":
        return;
      case "teardown":
        if (!loggedLateError) {
          loggedLateError = true;
          params.runtime.error?.(
            danger(
              `discord: suppressed late gateway ${event.type} error during teardown: ${event.message}`,
            ),
          );
        }
        return;
      case "active":
        lifecycleHandler?.(event);
        return;
      case "buffering":
        pending.push(event);
    }
  };
  removeDiscordGatewayLateErrorGuard(emitter);
  emitter.on("error", onGatewayError);

  return {
    emitter,
    attachLifecycle: (handler) => {
      lifecycleHandler = handler;
      phase = "active";
    },
    detachLifecycle: () => {
      lifecycleHandler = undefined;
      phase = "teardown";
    },
    drainPending: (handler) => {
      const queued = pending.splice(0);
      for (const event of queued) {
        if (handler(event) === "stop") {
          return "stop";
        }
      }
      return "continue";
    },
    dispose: () => {
      if (phase === "disposed") {
        return;
      }
      emitter.off("error", onGatewayError);
      ensureDiscordGatewayLateErrorGuard(emitter);
      lifecycleHandler = undefined;
      phase = "disposed";
      pending.length = 0;
    },
  };
}
