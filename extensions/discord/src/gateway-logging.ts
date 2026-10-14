import type { EventEmitter } from "node:events";
import { logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

type GatewayEmitter = Pick<EventEmitter, "on" | "removeListener">;

const INFO_DEBUG_MARKERS = [
  "Gateway websocket closed",
  "Gateway reconnect scheduled in",
  "Gateway forcing fresh IDENTIFY after",
];

const formatGatewayMetrics = (metrics: unknown) => {
  if (
    metrics == null ||
    typeof metrics === "string" ||
    typeof metrics === "number" ||
    typeof metrics === "boolean" ||
    typeof metrics === "bigint"
  ) {
    return String(metrics);
  }
  try {
    return JSON.stringify(metrics);
  } catch {
    return "[unserializable metrics]";
  }
};

export function attachDiscordGatewayLogging(params: {
  emitter?: GatewayEmitter;
  runtime: RuntimeEnv;
}) {
  const { emitter, runtime } = params;
  if (!emitter) {
    return () => {};
  }

  const onGatewayDebug = (msg: unknown) => {
    const message = String(msg);
    logVerbose(`discord gateway: ${message}`);
    if (INFO_DEBUG_MARKERS.some((marker) => message.includes(marker))) {
      runtime.log?.(`discord gateway: ${message}`);
    }
  };

  const onGatewayWarning = (warning: unknown) => {
    const message = `discord gateway warning: ${String(warning)}`;
    logVerbose(message);
    runtime.log?.(warn(message));
  };

  const onGatewayMetrics = (metrics: unknown) => {
    logVerbose(`discord gateway metrics: ${formatGatewayMetrics(metrics)}`);
  };

  emitter.on("debug", onGatewayDebug);
  emitter.on("warning", onGatewayWarning);
  emitter.on("metrics", onGatewayMetrics);

  return () => {
    emitter.removeListener("debug", onGatewayDebug);
    emitter.removeListener("warning", onGatewayWarning);
    emitter.removeListener("metrics", onGatewayMetrics);
  };
}
