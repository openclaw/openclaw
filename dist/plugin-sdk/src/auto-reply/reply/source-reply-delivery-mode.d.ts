import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionSendPolicyDecision } from "../../sessions/send-policy.js";
import { type CommandTurnContext } from "../command-turn-context.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
export type SourceReplyDeliveryModeContext = {
    ChatType?: string;
    InboundEventKind?: InboundEventKind;
    CommandAuthorized?: boolean;
    CommandBody?: string;
    CommandSource?: "text" | "native";
    CommandTurn?: CommandTurnContext;
};
export declare function isExplicitSourceReplyCommand(ctx: SourceReplyDeliveryModeContext): boolean;
export declare function resolveSourceReplyDeliveryMode(params: {
    cfg: OpenClawConfig;
    ctx: SourceReplyDeliveryModeContext;
    requested?: SourceReplyDeliveryMode;
    strictMessageToolOnly?: boolean;
    messageToolAvailable?: boolean;
    defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyDeliveryMode;
export type SourceReplyVisibilityPolicy = {
    sourceReplyDeliveryMode: SourceReplyDeliveryMode;
    sendPolicyDenied: boolean;
    suppressAutomaticSourceDelivery: boolean;
    suppressDelivery: boolean;
    suppressHookUserDelivery: boolean;
    suppressHookReplyLifecycle: boolean;
    suppressTyping: boolean;
    deliverySuppressionReason: string;
};
export declare function resolveSourceReplyVisibilityPolicy(params: {
    cfg: OpenClawConfig;
    ctx: SourceReplyDeliveryModeContext;
    requested?: SourceReplyDeliveryMode;
    strictMessageToolOnly?: boolean;
    sendPolicy: SessionSendPolicyDecision;
    suppressAcpChildUserDelivery?: boolean;
    explicitSuppressTyping?: boolean;
    shouldSuppressTyping?: boolean;
    messageToolAvailable?: boolean;
    defaultVisibleReplies?: "automatic" | "message_tool";
}): SourceReplyVisibilityPolicy;
