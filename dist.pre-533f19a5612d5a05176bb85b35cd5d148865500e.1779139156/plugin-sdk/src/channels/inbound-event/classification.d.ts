import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationFacts } from "../turn/types.js";
import type { InboundEventKind } from "./kind.js";
export type ClassifyChannelInboundEventParams = {
    conversation: Pick<ConversationFacts, "kind">;
    unmentionedGroupPolicy?: InboundEventKind;
    wasMentioned?: boolean;
    hasControlCommand?: boolean;
    hasAbortRequest?: boolean;
    commandSource?: "native" | "text";
};
export declare function classifyChannelInboundEvent(params: ClassifyChannelInboundEventParams): InboundEventKind;
export declare function resolveUnmentionedGroupInboundPolicy(params: {
    cfg: OpenClawConfig;
    agentId?: string;
}): InboundEventKind;
