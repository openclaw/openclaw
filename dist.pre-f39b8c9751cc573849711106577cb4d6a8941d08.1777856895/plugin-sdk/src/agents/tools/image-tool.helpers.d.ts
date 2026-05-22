import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
export type ImageModelConfig = ToolModelConfig;
export declare function hasImageReasoningOnlyResponse(message: AssistantMessage): boolean;
export declare function decodeDataUrl(dataUrl: string, opts?: {
    maxBytes?: number;
}): {
    buffer: Buffer;
    mimeType: string;
    kind: "image";
};
export declare function coerceImageAssistantText(params: {
    message: AssistantMessage;
    provider: string;
    model: string;
}): string;
export declare function coerceImageModelConfig(cfg?: OpenClawConfig): ImageModelConfig;
export declare function resolveConfiguredImageModelRefs(params: {
    cfg?: OpenClawConfig;
    imageModelConfig: ImageModelConfig;
}): ImageModelConfig;
export declare function resolveProviderVisionModelFromConfig(params: {
    cfg?: OpenClawConfig;
    provider: string;
}): string | null;
