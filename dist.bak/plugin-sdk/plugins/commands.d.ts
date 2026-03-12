/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */
import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext, PluginCommandResult } from "./types.js";
type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
    pluginId: string;
};
/**
 * Validate a command name.
 * Returns an error message if invalid, or null if valid.
 */
export declare function validateCommandName(name: string): string | null;
export type CommandRegistrationResult = {
    ok: boolean;
    error?: string;
};
/**
 * Register a plugin command.
 * Returns an error if the command name is invalid or reserved.
 */
export declare function registerPluginCommand(pluginId: string, command: OpenClawPluginCommandDefinition): CommandRegistrationResult;
/**
 * Clear all registered plugin commands.
 * Called during plugin reload.
 */
export declare function clearPluginCommands(): void;
/**
 * Clear plugin commands for a specific plugin.
 */
export declare function clearPluginCommandsForPlugin(pluginId: string): void;
/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export declare function matchPluginCommand(commandBody: string): {
    command: RegisteredPluginCommand;
    args?: string;
} | null;
/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export declare function executePluginCommand(params: {
    command: RegisteredPluginCommand;
    args?: string;
    senderId?: string;
    channel: string;
    channelId?: PluginCommandContext["channelId"];
    isAuthorizedSender: boolean;
    commandBody: string;
    config: OpenClawConfig;
    from?: PluginCommandContext["from"];
    to?: PluginCommandContext["to"];
    accountId?: PluginCommandContext["accountId"];
    messageThreadId?: PluginCommandContext["messageThreadId"];
}): Promise<PluginCommandResult>;
/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export declare function listPluginCommands(): Array<{
    name: string;
    description: string;
    pluginId: string;
}>;
/**
 * Get plugin command specs for native command registration (e.g., Telegram).
 */
export declare function getPluginCommandSpecs(): Array<{
    name: string;
    description: string;
}>;
export {};
