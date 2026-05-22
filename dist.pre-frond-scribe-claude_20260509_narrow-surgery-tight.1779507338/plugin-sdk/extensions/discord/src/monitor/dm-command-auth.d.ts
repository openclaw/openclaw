import { type ChannelIngressEventInput, type ResolveChannelMessageIngressParams } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RequestClient } from "../internal/discord.js";
export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
export declare function resolveDiscordDmCommandAccess(params: {
    accountId: string;
    dmPolicy: DiscordDmPolicy;
    configuredAllowFrom: string[];
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    allowNameMatching: boolean;
    cfg?: OpenClawConfig;
    token?: string;
    rest?: RequestClient;
    readStoreAllowFrom?: ResolveChannelMessageIngressParams["readStoreAllowFrom"];
    eventKind?: ChannelIngressEventInput["kind"];
}): Promise<import("openclaw/plugin-sdk/channel-ingress-runtime").ResolvedChannelMessageIngress>;
export declare function resolveDiscordTextCommandAccess(params: {
    accountId: string;
    sender: {
        id: string;
        name?: string;
        tag?: string;
    };
    ownerAllowFrom?: string[];
    memberAccessConfigured: boolean;
    memberAllowed: boolean;
    allowNameMatching: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    cfg?: OpenClawConfig;
    token?: string;
    rest?: RequestClient;
}): Promise<import("../../../../dist/plugin-sdk/src/channels/message-access/runtime-types.js").ChannelIngressCommandAccess>;
