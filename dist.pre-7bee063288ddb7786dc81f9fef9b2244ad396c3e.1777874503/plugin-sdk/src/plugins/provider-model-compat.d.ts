import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelCompatConfig } from "../config/types.models.js";
export declare function extractModelCompat(modelOrCompat: {
    compat?: unknown;
} | ModelCompatConfig | undefined): ModelCompatConfig | undefined;
export declare function applyModelCompatPatch<T extends {
    compat?: ModelCompatConfig;
}>(model: T, patch: ModelCompatConfig): T;
export declare function hasToolSchemaProfile(modelOrCompat: {
    compat?: unknown;
} | ModelCompatConfig | undefined, profile: string): boolean;
export declare function hasNativeWebSearchTool(modelOrCompat: {
    compat?: unknown;
} | ModelCompatConfig | undefined): boolean;
export declare function resolveToolCallArgumentsEncoding(modelOrCompat: {
    compat?: unknown;
} | ModelCompatConfig | undefined): ModelCompatConfig["toolCallArgumentsEncoding"] | undefined;
export declare function resolveUnsupportedToolSchemaKeywords(modelOrCompat: {
    compat?: unknown;
} | ModelCompatConfig | undefined): ReadonlySet<string>;
export declare function normalizeModelCompat(model: Model<Api>): Model<Api>;
