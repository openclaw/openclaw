import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandOptions } from "./commands.js";

/** Dispatches a `/codex` command to the lazily loaded handler. */
export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: CodexCommandOptions,
): Promise<PluginCommandResult> {
  const commandContext = { ...ctx, gatewayClientScopes: ctx.gatewayClientScopes?.slice() };
  const { resolvePluginConfig, ...subcommandOptions } = options;
  try {
    const { handleCodexSubcommand } = await import("./command-handlers.js");
    return await handleCodexSubcommand(commandContext, {
      ...subcommandOptions,
      pluginConfig: resolvePluginConfig?.() ?? subcommandOptions.pluginConfig,
    });
  } catch (error) {
    return {
      text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}`,
    };
  }
}
