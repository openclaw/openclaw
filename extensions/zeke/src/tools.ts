import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { callZekeFlowTool } from "./client.js";
import { resolveZekePluginConfig } from "./config.js";
import { ZEKE_TOOL_DEFINITIONS } from "./schemas.js";

function resolveSessionKey(rawParams: Record<string, unknown>): string | undefined {
  const value =
    rawParams.session_key ?? rawParams.sessionKey ?? rawParams.session_id ?? rawParams.sessionId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createZekeTools(api: OpenClawPluginApi) {
  const config = resolveZekePluginConfig(api);
  return ZEKE_TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    execute: async (toolCallId: string, rawParams: Record<string, unknown>) =>
      jsonResult(
        await callZekeFlowTool(config, definition.name, rawParams, {
          toolCallId,
          sessionKey: resolveSessionKey(rawParams),
        }),
      ),
  }));
}
