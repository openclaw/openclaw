import type { AgentMessage } from "@mariozechner/pi-agent-core";
type AssistantMessage = Extract<AgentMessage, {
    role: "assistant";
}>;
export declare function isAssistantMessageWithContent(message: AgentMessage): message is AssistantMessage;
/**
 * Strip all `type: "thinking"` content blocks from assistant messages.
 *
 * If an assistant message becomes empty after stripping, it is replaced with
 * a synthetic `{ type: "text", text: "" }` block to preserve turn structure
 * (some providers require strict user/assistant alternation).
 *
 * Returns the original array reference when nothing was changed (callers can
 * use reference equality to skip downstream work).
 */
export declare function dropThinkingBlocks(messages: AgentMessage[]): AgentMessage[];
export {};
