/** Model entry in the plugin config registry. */
export type ModelEntry = {
  displayName: string;
  modelIdentifier: string;
  startCommand: string;
  stopCommand: string;
  healthUrl: string;
  identityUrl: string;
  capabilities?: string[];
  contextWindow?: number;
  nativeContextWindow?: number;
  description?: string;
};

/** Resolved plugin config with defaults applied. */
export type ModelSwitchConfig = {
  models: Record<string, ModelEntry>;
  defaultModel: string;
  skipBootstrapBelowTokens: number;
  healthPollIntervalMs: number;
  healthTimeoutMs: number;
  switchTimeoutMs: number;
  staleMarkerMaxAgeMs: number;
  maxMarkerRetries: number;
  contextBridge: ContextBridgeConfig;
};

export type ContextBridgeConfig = {
  strategy: "bootstrap" | "compact" | "preserve";
  contextWindowBufferRatio: number;
  bootstrap: {
    summaryMaxTokens: number;
    preserveRecentTurns: number;
    preserveRecentMaxTokens: number;
    includeSystemPrompt: boolean;
  };
  compact: {
    targetTokens: number;
    preserveRecentTurns: number;
  };
};

/** Persisted marker file for crash recovery. */
export type SwitchMarker = {
  sessionKey: string;
  sourceModel: string;
  targetModel: string;
  reason?: string;
  continuationPrompt: string;
  requestedAt: string;
  attemptCount: number;
};

/** Result of a model identity check via /v1/models. */
export type ModelIdentityResult = {
  matched: boolean;
  foundId: string | null;
  expectedIdentifier: string;
};
