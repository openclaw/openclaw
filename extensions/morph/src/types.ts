/** Plugin-level configuration for the Morph extension. */
export type MorphPluginConfig = {
  apiKey?: string;
  apiUrl?: string;
  compressionRatio?: number;
  codebaseSearch?: {
    enabled?: boolean;
    timeout?: number;
    excludes?: string[];
  };
};
