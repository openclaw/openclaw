import { type ModelRef } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type ImageModelOverridePlan = {
    kind: "inline-session";
} | {
    kind: "inline-image-model";
    modelOverride: string;
    modelOverrideFallbacks: string[];
} | {
    kind: "media-paths";
    reason: "no-image-attachments" | "no-image-model" | "not-vision-capable";
};
export type ImageModelCapabilityResolver = (ref: ModelRef) => Promise<boolean>;
export declare function resolveImageModelOverridePlan(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider: string;
    defaultModel: string;
    hasImageAttachments: boolean;
    sessionModelSupportsImages: boolean;
    modelSupportsImages: ImageModelCapabilityResolver;
}): Promise<ImageModelOverridePlan>;
