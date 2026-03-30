import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
export declare function resolveSilentReplyFallbackText(params: {
    text: string;
    messagingToolSentTexts: string[];
}): string;
export declare function handleMessageStart(ctx: EmbeddedPiSubscribeContext, evt: AgentEvent & {
    message: AgentMessage;
}): void;
export declare function handleMessageUpdate(ctx: EmbeddedPiSubscribeContext, evt: AgentEvent & {
    message: AgentMessage;
    assistantMessageEvent?: unknown;
}): void;
export declare function handleMessageEnd(ctx: EmbeddedPiSubscribeContext, evt: AgentEvent & {
    message: AgentMessage;
}): void;
