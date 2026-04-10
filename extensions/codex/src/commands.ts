import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { handleCodexSubcommand } from "./command-handlers.js";

export function createCodexCommand(options: {
  pluginConfig?: unknown;
}): OpenClawPluginCommandDefinition {
  return {
    name: "codex",
    description: "Inspect and control the Codex app-server harness",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCodexCommand(ctx, options),
  };
}

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown } = {},
): Promise<{ text: string }> {
  return await handleCodexSubcommand(ctx, options);
}
