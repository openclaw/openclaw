import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { CodexPluginConfig } from "./config.js";
import {
  buildConfiguredCodexPluginRecords,
  createCodexPluginToolDefinition,
  type CodexPluginInventoryRecord,
} from "./plugin-inventory.js";
import { invokeCodexPluginTool } from "./plugin-tool-invoker.js";
import type { JsonValue } from "./protocol.js";

export function createConfiguredCodexPluginToolRegistrations(params: {
  pluginConfig: CodexPluginConfig;
}): Array<{
  name: string;
  record: CodexPluginInventoryRecord;
  factory: (
    context: OpenClawPluginToolContext,
  ) => ReturnType<typeof createCodexPluginToolDefinition>;
}> {
  return buildConfiguredCodexPluginRecords(params.pluginConfig).map((record) => ({
    name: record.toolName,
    record,
    factory: (context) =>
      createCodexPluginToolDefinition({
        record,
        execute: async (_toolCallId, args) => {
          const request = readRequest(args);
          const result = await invokeCodexPluginTool({
            pluginConfig: params.pluginConfig,
            record,
            request,
            context,
          });
          return {
            content: [{ type: "text", text: result.text }],
            details: result as unknown as JsonValue,
          };
        },
      }),
  }));
}

function readRequest(args: unknown): string {
  const record =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const request = record.request;
  if (typeof request !== "string" || request.trim().length === 0) {
    throw new Error("request required");
  }
  return request.trim();
}
