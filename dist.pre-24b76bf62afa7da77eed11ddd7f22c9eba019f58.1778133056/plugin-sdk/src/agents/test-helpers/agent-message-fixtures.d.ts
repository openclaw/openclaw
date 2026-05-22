import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
export declare function castAgentMessage(message: unknown): AgentMessage;
export declare function castAgentMessages(messages: unknown[]): AgentMessage[];
export declare function makeAgentUserMessage(overrides: Partial<UserMessage> & Pick<UserMessage, "content">): UserMessage;
export declare function makeAgentAssistantMessage(overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">): AssistantMessage;
