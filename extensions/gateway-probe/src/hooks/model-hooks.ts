import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { TelemetryCollector } from "../telemetry/collector.js";

export function registerModelHooks(api: OpenClawPluginApi, collector: TelemetryCollector): void {
  api.on("llm_output", (event, ctx) => {
    collector.recordModelResponseUsage({
      runId: event.runId,
      provider: event.provider,
      model: event.model,
      agentId: ctx.agentId,
      sessionId: event.sessionId,
      usage: event.usage,
    });
  });
}
