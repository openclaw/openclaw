//#region packages/memory-host-sdk/src/host/multimodal.d.ts
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
type MemoryMultimodalModality = keyof typeof MEMORY_MULTIMODAL_SPECS;
type MemoryMultimodalSelection = MemoryMultimodalModality | "all";
type MemoryMultimodalSettings = {
  enabled: boolean;
  modalities: MemoryMultimodalModality[];
  maxFileBytes: number;
};
declare function normalizeMemoryMultimodalSettings(raw: {
  enabled?: boolean;
  modalities?: MemoryMultimodalSelection[];
  maxFileBytes?: number;
}): MemoryMultimodalSettings;
declare function isMemoryMultimodalEnabled(settings: MemoryMultimodalSettings): boolean;
declare function getMemoryMultimodalExtensions(modality: MemoryMultimodalModality): readonly string[];
declare function buildCaseInsensitiveExtensionGlob(extension: string): string;
declare function classifyMemoryMultimodalPath(filePath: string, settings: MemoryMultimodalSettings): MemoryMultimodalModality | null;
//#endregion
export { getMemoryMultimodalExtensions as a, classifyMemoryMultimodalPath as i, MemoryMultimodalSettings as n, isMemoryMultimodalEnabled as o, buildCaseInsensitiveExtensionGlob as r, normalizeMemoryMultimodalSettings as s, MemoryMultimodalModality as t };