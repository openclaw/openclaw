declare const MEMORY_MULTIMODAL_SPECS: {
    readonly image: {
        readonly labelPrefix: "Image file";
        readonly extensions: readonly [".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"];
    };
    readonly audio: {
        readonly labelPrefix: "Audio file";
        readonly extensions: readonly [".mp3", ".wav", ".ogg", ".opus", ".m4a", ".aac", ".flac"];
    };
};
export type MemoryMultimodalModality = keyof typeof MEMORY_MULTIMODAL_SPECS;
export declare const MEMORY_MULTIMODAL_MODALITIES: MemoryMultimodalModality[];
export type MemoryMultimodalSelection = MemoryMultimodalModality | "all";
export type MemoryMultimodalSettings = {
    enabled: boolean;
    modalities: MemoryMultimodalModality[];
    maxFileBytes: number;
};
export declare const DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES: number;
export declare function normalizeMemoryMultimodalModalities(raw: MemoryMultimodalSelection[] | undefined): MemoryMultimodalModality[];
export declare function normalizeMemoryMultimodalSettings(raw: {
    enabled?: boolean;
    modalities?: MemoryMultimodalSelection[];
    maxFileBytes?: number;
}): MemoryMultimodalSettings;
export declare function isMemoryMultimodalEnabled(settings: MemoryMultimodalSettings): boolean;
export declare function getMemoryMultimodalExtensions(modality: MemoryMultimodalModality): readonly string[];
export declare function buildMemoryMultimodalLabel(modality: MemoryMultimodalModality, normalizedPath: string): string;
export declare function buildCaseInsensitiveExtensionGlob(extension: string): string;
export declare function classifyMemoryMultimodalPath(filePath: string, settings: MemoryMultimodalSettings): MemoryMultimodalModality | null;
export declare function normalizeGeminiEmbeddingModelForMemory(model: string): string;
export declare function supportsMemoryMultimodalEmbeddings(params: {
    provider: string;
    model: string;
}): boolean;
export {};
