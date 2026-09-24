import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { AgentToolResult } from "openclaw/plugin-sdk/tool-results";
import type { Static, TSchema } from "typebox";
import type { OpenClawConfig, OpenClawPluginApi } from "../runtime-api.js";
import { resolveAnyEnabledFeishuToolsConfig } from "./tool-account.js";
import { toolExecutionErrorResult } from "./tool-result.js";
import type { FeishuToolsConfig } from "./types.js";

export function registerFeishuTool<TSchemaType extends TSchema>(
  api: OpenClawPluginApi,
  tool: {
    name: string;
    label: string;
    description: string;
    family: keyof FeishuToolsConfig;
    parameters: TSchemaType;
    createExecute: (
      ctx: OpenClawPluginToolContext,
      cfg: OpenClawConfig,
    ) => (
      params: Static<TSchemaType> & { accountId?: string },
    ) => Promise<AgentToolResult<unknown>>;
    onError?: (error: unknown) => AgentToolResult<unknown>;
  },
) {
  api.registerTool(
    (ctx) => {
      const cfg = ctx.runtimeConfig ?? ctx.config ?? api.config;
      if (!cfg || !resolveAnyEnabledFeishuToolsConfig(cfg)[tool.family]) {
        return null;
      }
      const execute = tool.createExecute(ctx, cfg);
      return {
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        resultContentSource: "network",
        async execute(_toolCallId, params) {
          try {
            // SAFETY: The schema and executor share TSchemaType; the plugin API erases that generic.
            return await execute(params as Static<TSchemaType> & { accountId?: string });
          } catch (error) {
            return (tool.onError ?? toolExecutionErrorResult)(error);
          }
        },
      };
    },
    { name: tool.name },
  );
}
