import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { ContextVisibilityMode } from "../../config/types.base.js";
import type { AccessFacts, ConversationFacts, InboundMediaFacts, MessageFacts, ReplyPlanFacts, RouteFacts, SenderFacts, SupplementalContextFacts } from "./types.js";
export type BuildChannelTurnContextParams = {
    channel: string;
    accountId?: string;
    provider?: string;
    surface?: string;
    messageId?: string;
    messageIdFull?: string;
    timestamp?: number;
    from: string;
    sender: SenderFacts;
    conversation: ConversationFacts;
    route: RouteFacts;
    reply: ReplyPlanFacts;
    message: MessageFacts;
    access?: AccessFacts;
    media?: InboundMediaFacts[];
    supplemental?: SupplementalContextFacts;
    contextVisibility?: ContextVisibilityMode;
    extra?: Record<string, unknown>;
};
export declare function filterChannelTurnSupplementalContext(params: {
    supplemental?: SupplementalContextFacts;
    contextVisibility?: ContextVisibilityMode;
}): SupplementalContextFacts | undefined;
export declare function buildChannelTurnContext(params: BuildChannelTurnContextParams): FinalizedMsgContext;
