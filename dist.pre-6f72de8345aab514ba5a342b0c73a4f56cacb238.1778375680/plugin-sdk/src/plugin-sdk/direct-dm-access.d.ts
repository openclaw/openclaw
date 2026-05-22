import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type DmGroupAccessReasonCode } from "../security/dm-policy-shared.js";
import { type AccessGroupMembershipResolver } from "./access-groups.js";
export type { AccessGroupMembershipResolver } from "./access-groups.js";
export type DirectDmCommandAuthorizationRuntime = {
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
export type ResolvedInboundDirectDmAccess = {
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
export declare function resolveInboundDirectDmAccessWithRuntime(params: {
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
export declare function createPreCryptoDirectDmAuthorizer(params: {
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
