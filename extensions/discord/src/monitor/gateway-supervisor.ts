import type { EventEmitter } from "node:events";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getDiscordGatewayEmitter } from "../monitor.gateway.js";

export type DiscordGatewayEventType =
  | "disallowed-intents"
  | "fatal"
  | "other"
  | "reconnect-aborted"
  | "reconnect-exhausted";

export type DiscordGatewayEvent = {
  type: DiscordGatewayEventType;
  err: unknown;
  message: string;
  shouldStopLifecycle: boolean;
};

export type DiscordGatewaySupervisor = {
  emitter?: EventEmitter;
  attachLifecycle: (handler: (event: DiscordGatewayEvent) => void) => void;
  detachLifecycle: () => void;
  drainPending: (
    handler: (event: DiscordGatewayEvent) => "continue" | "stop",
  ) => "continue" | "stop";
  dispose: () => void;
  /**
   * Call this before triggering an intentional gateway abort (e.g. from the
   * health-monitor onAbort path). Marks the next reconnect-exhausted event as
   * reconnect-aborted so it does not stop the lifecycle.
   */
  markIntentionalAbort: () => void;
};

type GatewaySupervisorPhase = "active" | "buffering" | "disposed" | "teardown";

export function classifyDiscordGatewayEvent(params: {
  err: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
  isIntentionalAbort?: boolean;
}): DiscordGatewayEvent {
  const message = String(params.err);
  if (params.isDisallowedIntentsError(params.err)) {
    return {
      type: "disallowed-intents",
      err: params.err,
      message,
      shouldStopLifecycle: true,
    };
  }
  if (message.includes("Max reconnect attempts")) {
    return {
      type: params.isIntentionalAbort ? "reconnect-aborted" : "reconnect-exhausted",
      err: params.err,
      message,
      shouldStopLifecycle: !params.isIntentionalAbort,
    };
  }
  if (message.includes("Fatal Gateway error")) {
    return {
      type: "fatal",
      err: params.err,
      message,
      shouldStopLifecycle: true,
    };
  }
  return {
    type: "other",
    err: params.err,
    message,
    shouldStopLifecycle: false,
  };
}

export function createDiscordGatewaySupervisor(params: {
  /** Carbon Client — used by provider.ts; emitter is derived internally. */
  client?: unknown;
  /** Raw gateway object — used by tests. Takes precedence over client. */
  gateway?: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
  runtime: RuntimeEnv;
}): DiscordGatewaySupervisor {
  const emitter = getDiscordGatewayEmitter(params.gateway ?? params.client);
  const pending: DiscordGatewayEvent[] = [];
  if (!emitter) {
    return {
      attachLifecycle: () => {},
      detachLifecycle: () => {},
      drainPending: () => "continue",
      dispose: () => {},
      markIntentionalAbort: () => {},
      emitter,
    };
  }

  let lifecycleHandler: ((event: DiscordGatewayEvent) => void) | undefined;
  let phase: GatewaySupervisorPhase = "buffering";
  let intentionalAbort = false;

  const logLateEvent =
    (state: Extract<GatewaySupervisorPhase, "disposed" | "teardown">) =>
    (event: DiscordGatewayEvent) => {
      params.runtime.error?.(
        danger(
          `discord: suppressed late gateway ${event.type} error ${
            state === "disposed" ? "after dispose" : "during teardown"
          }: ${event.message}`,
        ),
      );
    };

  const onGatewayError = (err: unknown) => {
    const event = classifyDiscordGatewayEvent({
      err,
      isDisallowedIntentsError: params.isDisallowedIntentsError,
      isIntentionalAbort: intentionalAbort,
    });
    // Reset after consuming — one abort signal covers one disconnect.
    if (intentionalAbort && event.type === "reconnect-aborted") {
      intentionalAbort = false;
    }
    switch (phase) {
      case "disposed":
        logLateEvent("disposed")(event);
        return;
      case "active":
        lifecycleHandler?.(event);
        return;
      case "teardown":
        logLateEvent("teardown")(event);
        return;
      case "buffering":
        pending.push(event);
        return;
    }
  };
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
      if (pending.length === 0) {
        return "continue";
      }
      const queued = [...pending];
      pending.length = 0;
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
      lifecycleHandler = undefined;
      phase = "disposed";
      pending.length = 0;
    },
    markIntentionalAbort: () => {
      intentionalAbort = true;
    },
  };
}
