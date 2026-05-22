import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { t as ChannelId } from "./channel-id.types-_c58kC27.js";
import { r as DmGroupAccessReasonCode } from "./dm-policy-shared-LVfLuhge.js";
import { n as AccessGroupMembershipResolver } from "./access-groups-CIXMJ5U2.js";

//#region src/plugin-sdk/direct-dm-access.d.ts
type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{
      configured: boolean;
      allowed: boolean;
    }>;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
};
type ResolvedInboundDirectDmAccess = {
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
};
/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
declare function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  resolveAccessGroupMembership?: AccessGroupMembershipResolver;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess>;
/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
declare function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (senderId: string) => Promise<Pick<ResolvedInboundDirectDmAccess, "access"> | ResolvedInboundDirectDmAccess>;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: {
    senderId: string;
    reason: string;
    reasonCode: DmGroupAccessReasonCode;
  }) => void;
}): (input: {
  senderId: string;
  reply: (text: string) => Promise<void>;
}) => Promise<"allow" | "block" | "pairing">;
//#endregion
export { resolveInboundDirectDmAccessWithRuntime as i, ResolvedInboundDirectDmAccess as n, createPreCryptoDirectDmAuthorizer as r, DirectDmCommandAuthorizationRuntime as t };