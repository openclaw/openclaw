import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
export type ImageModelConfig = {
    primary?: string;
    fallbacks?: string[];
};
export declare function decodeDataUrl(dataUrl: string): {
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
export declare function resolveProviderVisionModelFromConfig(params: {
    cfg?: OpenClawConfig;
    provider: string;
}): string | null;
