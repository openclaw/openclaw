import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolveCommandConversationResolutionInput } from "./conversation-resolution.js";
type ConversationBindingContext = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string;
};
type ResolveConversationBindingContextInput = Omit<ResolveCommandConversationResolutionInput, "includePlacementHint"> & {
    cfg: OpenClawConfig;
};
export declare function resolveConversationBindingContext(params: ResolveConversationBindingContextInput): ConversationBindingContext | null;
export {};
