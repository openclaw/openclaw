import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TelemetryCollector } from "../telemetry/collector.js";

export function registerSessionHooks(api: OpenClawPluginApi, collector: TelemetryCollector): void {
  api.on("session_start", (event, ctx) => {
    collector.recordSessionStart({
      sessionId: event.sessionId,
      resumedFrom: event.resumedFrom,
      agentId: ctx.agentId,
      sessionKey: undefined,
    });
  });

  api.on("session_end", (event, ctx) => {
    collector.recordSessionEnd({
      sessionId: event.sessionId,
      agentId: ctx.agentId,
      durationMs: event.durationMs,
      messageCount: event.messageCount,
    });
  });

  api.on("gateway_start", (event) => {
    collector.recordGatewayStart({
      port: event.port,
    });
  });

  api.on("gateway_stop", (event) => {
    collector.recordGatewayStop({
      reason: event.reason,
    });
  });
}
