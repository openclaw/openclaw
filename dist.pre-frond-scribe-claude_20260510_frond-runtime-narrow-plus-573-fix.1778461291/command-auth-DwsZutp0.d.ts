import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { t as ChannelId } from "./channel-id.types-_c58kC27.js";
import { n as AccessGroupMembershipResolver } from "./access-groups-CIXMJ5U2.js";
import { a as buildHelpMessage$1, i as buildCommandsMessagePaginated$1, r as buildCommandsMessage$1 } from "./command-status-builders-Bjr506U8.js";
//#region src/plugin-sdk/telegram-command-ui.d.ts
declare function buildCommandsPaginationKeyboard(currentPage: number, totalPages: number, agentId?: string): Array<Array<{
  text: string;
  callback_data: string;
}>>;
//#endregion
//#region src/plugin-sdk/command-auth.d.ts
type ResolveSenderCommandAuthorizationParams = {
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
type CommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{
      configured: boolean;
      allowed: boolean;
    }>;
  }) => boolean;
};
type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<ResolveSenderCommandAuthorizationParams, "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"> & {
  runtime: CommandAuthorizationRuntime;
};
/** Fast-path DM command authorization when only policy and sender allowlist state matter. */
declare function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): "disabled" | "unauthorized" | "allowed";
/** Runtime-backed wrapper around sender command authorization for grouped helper surfaces. */
declare function resolveSenderCommandAuthorizationWithRuntime(params: ResolveSenderCommandAuthorizationWithRuntimeParams): ReturnType<typeof resolveSenderCommandAuthorization>;
/** Compute effective allowlists and command authorization for one inbound sender. */
declare function resolveSenderCommandAuthorization(params: ResolveSenderCommandAuthorizationParams): Promise<{
  shouldComputeAuth: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
declare function buildCommandsMessage(...args: Parameters<typeof buildCommandsMessage$1>): ReturnType<typeof buildCommandsMessage$1>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
declare function buildCommandsMessagePaginated(...args: Parameters<typeof buildCommandsMessagePaginated$1>): ReturnType<typeof buildCommandsMessagePaginated$1>;
/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
declare function buildHelpMessage(...args: Parameters<typeof buildHelpMessage$1>): ReturnType<typeof buildHelpMessage$1>;
//#endregion
export { buildCommandsMessagePaginated as a, resolveSenderCommandAuthorization as c, buildCommandsMessage as i, resolveSenderCommandAuthorizationWithRuntime as l, ResolveSenderCommandAuthorizationParams as n, buildHelpMessage as o, ResolveSenderCommandAuthorizationWithRuntimeParams as r, resolveDirectDmAuthorizationOutcome as s, CommandAuthorizationRuntime as t, buildCommandsPaginationKeyboard as u };