import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { ToolCallIdMode } from "../tool-call-id.js";
export declare function isEmptyAssistantMessageContent(message: Extract<AgentMessage, {
    role: "assistant";
}>): boolean;
export declare function sanitizeSessionMessagesImages(messages: AgentMessage[], label: string, options?: {
    sanitizeMode?: "full" | "images-only";
    sanitizeToolCallIds?: boolean;
    /**
     * Mode for tool call ID sanitization:
     * - "strict" (alphanumeric only)
     * - "strict9" (alphanumeric only, length 9)
     */
    toolCallIdMode?: ToolCallIdMode;
    preserveSignatures?: boolean;
    sanitizeThoughtSignatures?: {
        allowBase64Only?: boolean;
        includeCamelCase?: boolean;
    };
} & ImageSanitizationLimits): Promise<AgentMessage[]>;
