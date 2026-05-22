import { type OpenClawConfig } from "openclaw/plugin-sdk/account-core";
import type { DmPolicy, GroupPolicy, ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { WhatsAppAccountConfig } from "./account-types.js";
export { listWhatsAppAccountIds, resolveDefaultWhatsAppAccountId } from "./account-ids.js";
export type ResolvedWhatsAppAccount = {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    messagePrefix?: string;
    defaultTo?: string;
    authDir: string;
    isLegacyAuthDir: boolean;
    selfChatMode?: boolean;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    groupPolicy?: GroupPolicy;
    dmPolicy?: DmPolicy;
    historyLimit?: number;
    textChunkLimit?: number;
    chunkMode?: "length" | "newline";
    mediaMaxMb?: number;
    blockStreaming?: boolean;
    ackReaction?: WhatsAppAccountConfig["ackReaction"];
    reactionLevel?: WhatsAppAccountConfig["reactionLevel"];
    groups?: WhatsAppAccountConfig["groups"];
    direct?: WhatsAppAccountConfig["direct"];
    debounceMs?: number;
    replyToMode?: ReplyToMode;
};
export declare const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;
export declare function listWhatsAppAuthDirs(cfg: OpenClawConfig): string[];
export declare function hasAnyWhatsAppAuth(cfg: OpenClawConfig): boolean;
export declare function resolveWhatsAppAuthDir(params: {
    cfg: OpenClawConfig;
    accountId: string;
}): {
    authDir: string;
    isLegacy: boolean;
};
export declare function resolveWhatsAppAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedWhatsAppAccount;
export declare function resolveWhatsAppMediaMaxBytes(account: Pick<ResolvedWhatsAppAccount, "mediaMaxMb">): number;
export declare function listEnabledWhatsAppAccounts(cfg: OpenClawConfig): ResolvedWhatsAppAccount[];
