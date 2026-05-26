//#region src/plugins/config-normalization-shared.d.ts
type NormalizedPluginsConfig = {
  enabled: boolean;
  allow: string[];
  deny: string[];
  loadPaths: string[];
  slots: {
    memory?: string | null;
    contextEngine?: string | null;
  };
  entries: Record<string, {
    enabled?: boolean;
    hooks?: {
      allowPromptInjection?: boolean;
      allowConversationAccess?: boolean;
      timeoutMs?: number;
      timeouts?: Record<string, number>;
    };
    subagent?: {
      allowModelOverride?: boolean;
      allowedModels?: string[];
      hasAllowedModelsConfig?: boolean;
    };
    llm?: {
      allowModelOverride?: boolean;
      allowedModels?: string[];
      hasAllowedModelsConfig?: boolean;
      allowAgentIdOverride?: boolean;
    };
    config?: unknown;
  }>;
};
//#endregion
export { NormalizedPluginsConfig as t };