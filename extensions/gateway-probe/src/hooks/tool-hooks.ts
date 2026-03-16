import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TelemetryCollector } from "../telemetry/collector.js";

export function registerToolHooks(api: OpenClawPluginApi, collector: TelemetryCollector): void {
  api.on("after_tool_call", (event, ctx) => {
    collector.recordToolCallFinished({
      toolName: event.toolName,
      durationMs: event.durationMs,
      error: event.error,
      agentId: ctx.agentId,
      sessionKey: ctx.sessionKey,
    });
  });
}
