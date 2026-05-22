import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare function hasMeaningfulConversationContent(message: AgentMessage): boolean;
export declare function isRealConversationMessage(message: AgentMessage, messages: AgentMessage[], index: number): boolean;
