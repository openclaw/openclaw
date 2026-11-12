import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { describeControlFailure } from "./app-server/capabilities.js";
import { formatCodexDisplayText } from "./command-formatters.js";
import type { CodexCommandOptions } from "./commands.js";

const loadCommandHandlers = createLazyRuntimeModule(() => import("./command-handlers.js"));

export async function handleCodexCommand(
  ctx: PluginCommandContext,
  options: CodexCommandOptions,
): Promise<PluginCommandResult> {
  const { resolvePluginConfig, ...subcommandOptions } = options;
  try {
    const { handleCodexSubcommand } = await loadCommandHandlers();
    return await handleCodexSubcommand(ctx, {
      ...subcommandOptions,
      pluginConfig: resolvePluginConfig?.() ?? subcommandOptions.pluginConfig,
    });
  } catch (error) {
    return {
      text: `Codex command failed: ${formatCodexDisplayText(describeControlFailure(error))}`,
    };
  }
}
