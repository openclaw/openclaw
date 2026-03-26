import type { EventEmitter } from "node:events";
import type { Client } from "@buape/carbon";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { getDiscordGatewayEmitter } from "../monitor.gateway.js";

export type DiscordGatewayEventType =
  | "disallowed-intents"
  | "fatal"
  | "other"
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
};

type GatewaySupervisorPhase = "active" | "buffering" | "disposed" | "teardown";

export function classifyDiscordGatewayEvent(params: {
  err: unknown;
  isDisallowedIntentsError: (err: unknown) => boolean;
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
      type: "reconnect-exhausted",
      err: params.err,
      message,
      shouldStopLifecycle: true,
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
  client: Client;
  isDisallowedIntentsError: (err: unknown) => boolean;
  runtime: RuntimeEnv;
}): DiscordGatewaySupervisor {
  const gateway = params.client.getPlugin("gateway");
  const emitter = getDiscordGatewayEmitter(gateway);
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
  let disposed = false;
  const logLateTeardownEvent = (event: DiscordGatewayEvent) => {
    params.runtime.error?.(
      danger(
        `discord: suppressed late gateway ${event.type} error during teardown: ${event.message}`,
      ),
    );
  };
  const logLateDisposedEvent = (event: DiscordGatewayEvent) => {
    params.runtime.error?.(
      danger(`discord: suppressed late gateway ${event.type} error after dispose: ${event.message}`),
    );
  };
  const onGatewayError = (err: unknown) => {
    const event = classifyDiscordGatewayEvent({
      err,
      isDisallowedIntentsError: params.isDisallowedIntentsError,
    });
    if (phase === "disposed") {
      logLateDisposedEvent(event);
      return;
    }
    if (phase === "active" && lifecycleHandler) {
      lifecycleHandler(event);
      return;
    }
    if (phase === "teardown") {
      logLateTeardownEvent(event);
      return;
    }
    pending.push(event);
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
      if (disposed) {
        return;
      }
      disposed = true;
      lifecycleHandler = undefined;
      phase = "disposed";
      pending.length = 0;
    },
  };
}
