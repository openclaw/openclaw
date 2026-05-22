import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig } from "openclaw/plugin-sdk/config-contracts";
import { stripUndefinedFields } from "./send.shared.js";
type PendingApproval = {
    discordMessageId: string;
    discordChannelId: string;
};
type DiscordPendingDelivery = {
    body: ReturnType<typeof stripUndefinedFields>;
};
type PreparedDeliveryTarget = {
    discordChannelId: string;
    recipientUserId?: string;
};
export type DiscordApprovalHandlerContext = {
    token: string;
    config: DiscordExecApprovalConfig;
};
export declare function buildExecApprovalCustomId(approvalId: string, action: ExecApprovalDecision): string;
export declare const discordApprovalNativeRuntime: import("openclaw/plugin-sdk/approval-handler-runtime").ChannelApprovalNativeRuntimeAdapter<DiscordPendingDelivery, PreparedDeliveryTarget, PendingApproval, never, unknown>;
export {};
