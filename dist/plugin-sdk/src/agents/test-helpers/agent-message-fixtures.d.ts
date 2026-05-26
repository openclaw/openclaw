import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
export declare function castAgentMessage(message: unknown): AgentMessage;
export declare function castAgentMessages(messages: unknown[]): AgentMessage[];
export declare function makeAgentUserMessage(overrides: Partial<UserMessage> & Pick<UserMessage, "content">): UserMessage;
export declare function makeAgentAssistantMessage(overrides: Partial<AssistantMessage> & Pick<AssistantMessage, "content">): AssistantMessage;
