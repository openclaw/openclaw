import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { MediaUnderstandingConfig } from "../config/types.tools.js";
import type { ActiveMediaModel } from "./active-model.types.js";
import { MediaAttachmentCache } from "./attachments.js";
import type { MediaAttachment, MediaUnderstandingCapability, MediaUnderstandingDecision, MediaUnderstandingOutput, MediaUnderstandingProvider } from "./types.js";
export { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";
export type { ActiveMediaModel } from "./active-model.types.js";
type ProviderRegistry = Map<string, MediaUnderstandingProvider>;
export type RunCapabilityResult = {
    outputs: MediaUnderstandingOutput[];
    decision: MediaUnderstandingDecision;
};
export declare function buildProviderRegistry(overrides?: Record<string, MediaUnderstandingProvider>, cfg?: OpenClawConfig): ProviderRegistry;
export declare function resolveMediaAttachmentLocalRoots(params: {
    cfg: OpenClawConfig;
    ctx: MsgContext;
}): readonly string[];
export declare function clearMediaUnderstandingBinaryCacheForTests(): void;
export declare function resolveAutoImageModel(params: {
    cfg: OpenClawConfig;
    agentDir?: string;
    activeModel?: ActiveMediaModel;
}): Promise<ActiveMediaModel | null>;
export declare function runCapability(params: {
    capability: MediaUnderstandingCapability;
    cfg: OpenClawConfig;
    ctx: MsgContext;
    attachments: MediaAttachmentCache;
    media: MediaAttachment[];
    agentDir?: string;
    providerRegistry: ProviderRegistry;
    config?: MediaUnderstandingConfig;
    activeModel?: ActiveMediaModel;
}): Promise<RunCapabilityResult>;
