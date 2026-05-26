import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { n as AccessGroupMembershipResolver } from "./access-groups-CJtaNHhG.js";
import { a as buildHelpMessage$1, i as buildCommandsMessagePaginated$1, r as buildCommandsMessage$1 } from "./command-status-builders-GamA4sak.js";

//#region src/plugin-sdk/telegram-command-ui.d.ts
declare function buildCommandsPaginationKeyboard(currentPage: number, totalPages: number, agentId?: string): Array<Array<{
  text: string;
  callback_data: string;
}>>;
//#endregion
//#region src/plugin-sdk/command-auth.d.ts
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean; /** @deprecated Command authorization is resolved by channel ingress. Kept for runtime injection compatibility. */
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{
      configured: boolean;
      allowed: boolean;
    }>;
  }) => boolean;
};
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<ResolveSenderCommandAuthorizationParams, "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"> & {
  runtime: CommandAuthorizationRuntime;
};
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
declare function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): "disabled" | "unauthorized" | "allowed";
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
declare function resolveSenderCommandAuthorizationWithRuntime(params: ResolveSenderCommandAuthorizationWithRuntimeParams): ReturnType<typeof resolveSenderCommandAuthorization>;
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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