//#region extensions/memory-lancedb/config.d.ts
type MemoryConfig = {
  embedding: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    dimensions?: number;
  };
  dreaming?: Record<string, unknown>;
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  captureMaxChars?: number;
  customTriggers?: string[];
  recallMaxChars?: number;
  storageOptions?: Record<string, string>;
};
declare const MEMORY_CATEGORIES: readonly ["preference", "fact", "decision", "entity", "other"];
type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
declare const DEFAULT_CAPTURE_MAX_CHARS = 500;
declare const DEFAULT_RECALL_MAX_CHARS = 1000;
declare function vectorDimsForModel(model: string): number;
declare const memoryConfigSchema: {
  parse(value: unknown): MemoryConfig;
  uiHints: {
    "embedding.provider": {
      label: string;
      placeholder: string;
      help: string;
    };
    "embedding.apiKey": {
      label: string;
      sensitive: boolean;
      placeholder: string;
      help: string;
    };
    "embedding.baseUrl": {
      label: string;
      placeholder: string;
      help: string;
      advanced: boolean;
    };
    "embedding.dimensions": {
      label: string;
      placeholder: string;
      help: string;
      advanced: boolean;
    };
    "embedding.model": {
      label: string;
      placeholder: string;
      help: string;
    };
    dbPath: {
      label: string;
      placeholder: string;
      advanced: boolean;
      help: string;
    };
    autoCapture: {
      label: string;
      help: string;
    };
    autoRecall: {
      label: string;
      help: string;
    };
    captureMaxChars: {
      label: string;
      help: string;
      advanced: boolean;
      placeholder: string;
    };
    customTriggers: {
      label: string;
      help: string;
      advanced: boolean;
    };
    recallMaxChars: {
      label: string;
      help: string;
      advanced: boolean;
      placeholder: string;
    };
    storageOptions: {
      label: string;
      sensitive: boolean;
      advanced: boolean;
      help: string;
    };
  };
};
//#endregion
export { MemoryConfig as a, MemoryCategory as i, DEFAULT_RECALL_MAX_CHARS as n, memoryConfigSchema as o, MEMORY_CATEGORIES as r, vectorDimsForModel as s, DEFAULT_CAPTURE_MAX_CHARS as t };