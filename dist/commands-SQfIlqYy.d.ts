import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { O as OpenClawPluginCommandDefinition, at as PluginCommandContext, ct as PluginCommandResult, i as AgentPromptSurfaceKind } from "./types-Vx7Jq4_-2.js";
//#region src/plugins/command-registry-state.d.ts
type RegisteredPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};
declare function clearPluginCommands(): void;
declare function clearPluginCommandsForPlugin(pluginId: string): void;
declare function listRegisteredPluginAgentPromptGuidance(params?: {
  surface?: AgentPromptSurfaceKind;
  includeLegacyGlobalGuidance?: boolean;
}): string[];
//#endregion
//#region src/plugins/command-registration.d.ts
type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};
declare function validateCommandName(name: string, opts?: {
  allowReservedCommandNames?: boolean;
}): string | null;
/**
 * Validate a plugin command definition without registering it.
 * Returns an error message if invalid, or null if valid.
 * Shared by both the global registration path and snapshot (non-activating) loads.
 */
declare function validatePluginCommandDefinition(command: OpenClawPluginCommandDefinition, opts?: {
  allowReservedCommandNames?: boolean;
}): string | null;
declare function registerPluginCommand(pluginId: string, command: OpenClawPluginCommandDefinition, opts?: {
  pluginName?: string;
  pluginRoot?: string;
  allowReservedCommandNames?: boolean;
}): CommandRegistrationResult;
//#endregion
//#region src/plugins/commands.d.ts
/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
declare function matchPluginCommand(commandBody: string, options?: {
  channel?: string;
}): {
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
declare function executePluginCommand(params: {
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
declare function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
  acceptsArgs: boolean;
}>;
declare const testing: {
  resolveBindingConversationFromCommand: typeof resolveBindingConversationFromCommand;
};
//#endregion
export { registerPluginCommand as a, clearPluginCommands as c, testing as i, clearPluginCommandsForPlugin as l, listPluginCommands as n, validateCommandName as o, matchPluginCommand as r, validatePluginCommandDefinition as s, executePluginCommand as t, listRegisteredPluginAgentPromptGuidance as u };