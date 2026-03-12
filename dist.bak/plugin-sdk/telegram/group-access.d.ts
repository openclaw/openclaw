import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { TelegramAccountConfig, TelegramGroupConfig, TelegramTopicConfig } from "../config/types.js";
import { type NormalizedAllowFrom } from "./bot-access.js";
export type TelegramGroupBaseBlockReason = "group-disabled" | "topic-disabled" | "group-override-unauthorized";
export type TelegramGroupBaseAccessResult = {
    allowed: true;
} | {
    allowed: false;
    reason: TelegramGroupBaseBlockReason;
};
export declare const evaluateTelegramGroupBaseAccess: (params: {
    isGroup: boolean;
    groupConfig?: TelegramGroupConfig;
    topicConfig?: TelegramTopicConfig;
    hasGroupAllowOverride: boolean;
    effectiveGroupAllow: NormalizedAllowFrom;
    senderId?: string;
    senderUsername?: string;
    enforceAllowOverride: boolean;
    requireSenderForAllowOverride: boolean;
}) => TelegramGroupBaseAccessResult;
export type TelegramGroupPolicyBlockReason = "group-policy-disabled" | "group-policy-allowlist-no-sender" | "group-policy-allowlist-empty" | "group-policy-allowlist-unauthorized" | "group-chat-not-allowed";
export type TelegramGroupPolicyAccessResult = {
    allowed: true;
    groupPolicy: "open" | "disabled" | "allowlist";
} | {
    allowed: false;
    reason: TelegramGroupPolicyBlockReason;
    groupPolicy: "open" | "disabled" | "allowlist";
};
export declare const resolveTelegramRuntimeGroupPolicy: (params: {
    providerConfigPresent: boolean;
    groupPolicy?: TelegramAccountConfig["groupPolicy"];
    defaultGroupPolicy?: TelegramAccountConfig["groupPolicy"];
}) => import("../config/runtime-group-policy.js").RuntimeGroupPolicyResolution;
export declare const evaluateTelegramGroupPolicyAccess: (params: {
    isGroup: boolean;
    chatId: string | number;
    cfg: OpenClawConfig;
    telegramCfg: TelegramAccountConfig;
    topicConfig?: TelegramTopicConfig;
    groupConfig?: TelegramGroupConfig;
    effectiveGroupAllow: NormalizedAllowFrom;
    senderId?: string;
    senderUsername?: string;
    resolveGroupPolicy: (chatId: string | number) => ChannelGroupPolicy;
    enforcePolicy: boolean;
    useTopicAndGroupOverrides: boolean;
    enforceAllowlistAuthorization: boolean;
    allowEmptyAllowlistEntries: boolean;
    requireSenderForAllowlistAuthorization: boolean;
    checkChatAllowlist: boolean;
}) => TelegramGroupPolicyAccessResult;
