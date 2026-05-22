/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginCommands, clearPluginCommandsForPlugin, registerPluginCommand, validateCommandName, validatePluginCommandDefinition } from "./command-registration.js";
import { type RegisteredPluginCommand } from "./command-registry-state.js";
import { getPluginCommandSpecs, listProviderPluginCommandSpecs } from "./command-specs.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";
export { clearPluginCommands, clearPluginCommandsForPlugin, getPluginCommandSpecs, listProviderPluginCommandSpecs, registerPluginCommand, validateCommandName, validatePluginCommandDefinition, };
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
declare function resolveBindingConversationFromCommand(params: {
    config?: OpenClawConfig;
    channel: string;
    senderId?: string;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
    threadParentId?: string;
}): {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
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
    senderIsOwner?: boolean;
    gatewayClientScopes?: PluginCommandContext["gatewayClientScopes"];
    sessionKey?: PluginCommandContext["sessionKey"];
    sessionId?: PluginCommandContext["sessionId"];
    sessionFile?: PluginCommandContext["sessionFile"];
    commandBody: string;
    config: OpenClawConfig;
    from?: PluginCommandContext["from"];
    to?: PluginCommandContext["to"];
    accountId?: PluginCommandContext["accountId"];
    messageThreadId?: PluginCommandContext["messageThreadId"];
    threadParentId?: PluginCommandContext["threadParentId"];
    diagnosticsSessions?: PluginCommandContext["diagnosticsSessions"];
    diagnosticsUploadApproved?: PluginCommandContext["diagnosticsUploadApproved"];
    diagnosticsPreviewOnly?: PluginCommandContext["diagnosticsPreviewOnly"];
    diagnosticsPrivateRouted?: PluginCommandContext["diagnosticsPrivateRouted"];
}): Promise<PluginCommandResult>;
/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export declare function listPluginCommands(): Array<{
    name: string;
    description: string;
    pluginId: string;
    acceptsArgs: boolean;
}>;
export declare const __testing: {
    resolveBindingConversationFromCommand: typeof resolveBindingConversationFromCommand;
};
