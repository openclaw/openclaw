import type { OpenClawConfig } from "../config/config.js";
import type { DmPolicy, GroupPolicy, WhatsAppAccountConfig } from "../config/types.js";
export type ResolvedWhatsAppAccount = {
    accountId: string;
    name?: string;
    enabled: boolean;
    sendReadReceipts: boolean;
    messagePrefix?: string;
    authDir: string;
    isLegacyAuthDir: boolean;
    selfChatMode?: boolean;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    groupPolicy?: GroupPolicy;
    dmPolicy?: DmPolicy;
    textChunkLimit?: number;
    chunkMode?: "length" | "newline";
    mediaMaxMb?: number;
    blockStreaming?: boolean;
    ackReaction?: WhatsAppAccountConfig["ackReaction"];
    groups?: WhatsAppAccountConfig["groups"];
    debounceMs?: number;
};
export declare const listWhatsAppAccountIds: (cfg: OpenClawConfig) => string[];
export declare const resolveDefaultWhatsAppAccountId: (cfg: OpenClawConfig) => string;
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
export declare function listEnabledWhatsAppAccounts(cfg: OpenClawConfig): ResolvedWhatsAppAccount[];
