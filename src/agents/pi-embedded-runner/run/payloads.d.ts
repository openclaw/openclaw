import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ToolResultFormat } from "../../pi-embedded-subscribe.shared-types.js";
import { type ToolErrorSummary } from "../../tool-error-summary.js";
type ToolMetaEntry = {
    toolName: string;
    meta?: string;
};
export declare function buildEmbeddedRunPayloads(params: {
    assistantTexts: string[];
    toolMetas: ToolMetaEntry[];
    lastAssistant: AssistantMessage | undefined;
    lastToolError?: ToolErrorSummary;
    config?: OpenClawConfig;
    isCronTrigger?: boolean;
    sessionKey: string;
    provider?: string;
    model?: string;
    verboseLevel?: VerboseLevel;
    reasoningLevel?: ReasoningLevel;
    toolResultFormat?: ToolResultFormat;
    suppressToolErrorWarnings?: boolean;
    inlineToolResultsAllowed: boolean;
    didSendViaMessagingTool?: boolean;
    didSendDeterministicApprovalPrompt?: boolean;
}): Array<{
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    isError?: boolean;
    isReasoning?: boolean;
    audioAsVoice?: boolean;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
}>;
export {};
