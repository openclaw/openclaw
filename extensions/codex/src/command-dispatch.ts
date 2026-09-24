import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandOptions } from "./commands.js";

type CodexSubcommandHandler = (
  ctx: PluginCommandContext,
  options: CodexCommandOptions,
) => Promise<PluginCommandResult>;

type CodexCommandInternalOptions = CodexCommandOptions & {
  loadSubcommandHandler?: () => Promise<CodexSubcommandHandler>;
};

/** Dispatches a `/codex` command to the lazily loaded handler. */
export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: CodexCommandInternalOptions,
): Promise<PluginCommandResult> {
  const commandContext = { ...ctx, gatewayClientScopes: ctx.gatewayClientScopes?.slice() };
  const { loadSubcommandHandler, resolvePluginConfig, ...subcommandOptions } = options;
  try {
    const handleCodexSubcommand = loadSubcommandHandler
      ? await loadSubcommandHandler()
      : (await import("./command-handlers.js")).handleCodexSubcommand;
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
