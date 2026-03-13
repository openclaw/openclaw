import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import type { MediaUnderstandingConfig, MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { MediaAttachmentCache } from "./attachments.js";
import type { MediaUnderstandingCapability, MediaUnderstandingDecision, MediaUnderstandingModelDecision, MediaUnderstandingOutput, MediaUnderstandingProvider } from "./types.js";
export type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
export declare function buildModelDecision(params: {
    entry: MediaUnderstandingModelConfig;
    entryType: "provider" | "cli";
    outcome: MediaUnderstandingModelDecision["outcome"];
    reason?: string;
}): MediaUnderstandingModelDecision;
export declare function formatDecisionSummary(decision: MediaUnderstandingDecision): string;
export declare function runProviderEntry(params: {
    capability: MediaUnderstandingCapability;
    entry: MediaUnderstandingModelConfig;
    cfg: OpenClawConfig;
    ctx: MsgContext;
    attachmentIndex: number;
    cache: MediaAttachmentCache;
    agentDir?: string;
    providerRegistry: ProviderRegistry;
    config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null>;
export declare function runCliEntry(params: {
    capability: MediaUnderstandingCapability;
    entry: MediaUnderstandingModelConfig;
    cfg: OpenClawConfig;
    ctx: MsgContext;
    attachmentIndex: number;
    cache: MediaAttachmentCache;
    config?: MediaUnderstandingConfig;
}): Promise<MediaUnderstandingOutput | null>;
