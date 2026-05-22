import { buildCommandsMessage as buildCommandsMessageCompat, buildCommandsMessagePaginated as buildCommandsMessagePaginatedCompat, buildHelpMessage as buildHelpMessageCompat } from "../auto-reply/command-status-builders.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AccessGroupMembershipResolver } from "./access-groups.js";
export { ACCESS_GROUP_ALLOW_FROM_PREFIX, expandAllowFromWithAccessGroups, parseAccessGroupAllowFromEntry, resolveAccessGroupAllowFromMatches, type AccessGroupMembershipResolver, } from "./access-groups.js";
export { buildCommandsPaginationKeyboard } from "./telegram-command-ui.js";
export { createPreCryptoDirectDmAuthorizer, resolveInboundDirectDmAccessWithRuntime, type DirectDmCommandAuthorizationRuntime, type ResolvedInboundDirectDmAccess, } from "./direct-dm.js";
export { hasControlCommand, hasInlineCommandTokens, isControlCommandMessage, shouldComputeCommandAuthorized, } from "../auto-reply/command-detection.js";
export { buildCommandText, buildCommandTextFromArgs, findCommandByNativeName, formatCommandArgMenuTitle, getCommandDetection, isCommandEnabled, isCommandMessage, isNativeCommandSurface, listChatCommands, listChatCommandsForConfig, listNativeCommandSpecs, listNativeCommandSpecsForConfig, maybeResolveTextAlias, normalizeCommandBody, parseCommandArgs, resolveCommandArgChoices, resolveCommandArgMenu, resolveTextCommand, serializeCommandArgs, shouldHandleTextCommands, } from "../auto-reply/commands-registry.js";
export type { ChatCommandDefinition, CommandArgChoiceContext, CommandArgDefinition, CommandArgMenuSpec, CommandArgValues, CommandArgs, CommandDetection, CommandNormalizeOptions, CommandScope, NativeCommandSpec, ResolvedCommandArgChoice, ShouldHandleTextCommandsParams, } from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export { resolveCommandAuthorizedFromAuthorizers, resolveControlCommandGate, resolveDualTextControlCommandGate, type CommandAuthorizer, type CommandGatingModeWhenAccessGroupsOff, } from "../channels/command-gating.js";
export { resolveNativeCommandSessionTargets, type ResolveNativeCommandSessionTargetsParams, } from "../channels/native-command-session-targets.js";
export { resolveCommandAuthorization, type CommandAuthorization, } from "../auto-reply/command-auth.js";
export { listReservedChatSlashCommandNames, listSkillCommandsForAgents, listSkillCommandsForWorkspace, resolveSkillCommandInvocation, } from "../auto-reply/skill-commands.js";
export { getPluginCommandSpecs, listProviderPluginCommandSpecs } from "../plugins/command-specs.js";
export type { SkillCommandSpec } from "../agents/skills.js";
export { buildModelsProviderData, formatModelsAvailableHeader, resolveModelsCommandReply, } from "../auto-reply/reply/commands-models.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export type { StoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export type ResolveSenderCommandAuthorizationParams = {
    cfg: OpenClawConfig;
    rawBody: string;
    isGroup: boolean;
    dmPolicy: string;
    configuredAllowFrom: string[];
    configuredGroupAllowFrom?: string[];
    senderId: string;
    isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
    channel?: ChannelId;
    accountId?: string;
    resolveAccessGroupMembership?: AccessGroupMembershipResolver;
    readAllowFromStore: () => Promise<string[]>;
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
    resolveCommandAuthorizedFromAuthorizers: (params: {
        useAccessGroups: boolean;
        authorizers: Array<{
            configured: boolean;
            allowed: boolean;
        }>;
    }) => boolean;
};
export type CommandAuthorizationRuntime = {
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
    resolveCommandAuthorizedFromAuthorizers: (params: {
        useAccessGroups: boolean;
        authorizers: Array<{
            configured: boolean;
            allowed: boolean;
        }>;
    }) => boolean;
};
export type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<ResolveSenderCommandAuthorizationParams, "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"> & {
    runtime: CommandAuthorizationRuntime;
};
/** Fast-path DM command authorization when only policy and sender allowlist state matter. */
export declare function resolveDirectDmAuthorizationOutcome(params: {
    isGroup: boolean;
    dmPolicy: string;
    senderAllowedForCommands: boolean;
}): "disabled" | "unauthorized" | "allowed";
/** Runtime-backed wrapper around sender command authorization for grouped helper surfaces. */
export declare function resolveSenderCommandAuthorizationWithRuntime(params: ResolveSenderCommandAuthorizationWithRuntimeParams): ReturnType<typeof resolveSenderCommandAuthorization>;
/** Compute effective allowlists and command authorization for one inbound sender. */
export declare function resolveSenderCommandAuthorization(params: ResolveSenderCommandAuthorizationParams): Promise<{
    shouldComputeAuth: boolean;
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
    senderAllowedForCommands: boolean;
    commandAuthorized: boolean | undefined;
}>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export declare function buildCommandsMessage(...args: Parameters<typeof buildCommandsMessageCompat>): ReturnType<typeof buildCommandsMessageCompat>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export declare function buildCommandsMessagePaginated(...args: Parameters<typeof buildCommandsMessagePaginatedCompat>): ReturnType<typeof buildCommandsMessagePaginatedCompat>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export declare function buildHelpMessage(...args: Parameters<typeof buildHelpMessageCompat>): ReturnType<typeof buildHelpMessageCompat>;
