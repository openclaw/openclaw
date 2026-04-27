import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const TOOL_RESULT_REAL_CONVERSATION_LOOKBACK = 20;
export declare function hasMeaningfulConversationContent(message: AgentMessage): boolean;
export declare function isRealConversationMessage(message: AgentMessage, messages: AgentMessage[], index: number): boolean;
