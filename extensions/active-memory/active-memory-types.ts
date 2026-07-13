export type ActiveMemoryThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max";

export type ActiveMemoryPromptStyle =
  | "balanced"
  | "strict"
  | "contextual"
  | "recall-heavy"
  | "precision-heavy"
  | "preference-only";

export type ActiveMemoryQmdSearchMode = "inherit" | "search" | "vsearch" | "query";

export type ActiveRecallPluginConfig = {
  enabled?: boolean;
  agents?: string[];
  model?: string;
  modelFallback?: string;
  modelFallbackPolicy?: "default-remote" | "resolved-only";
  allowedChatTypes?: Array<"direct" | "group" | "channel" | "explicit">;
  allowedChatIds?: string[];
  deniedChatIds?: string[];
  thinking?: ActiveMemoryThinkingLevel;
  promptStyle?: ActiveMemoryPromptStyle;
  toolsAllow?: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs?: number;
  setupGraceTimeoutMs?: number;
  queryMode?: "message" | "recent" | "full";
  maxSummaryChars?: number;
  recentUserTurns?: number;
  recentAssistantTurns?: number;
  recentUserChars?: number;
  recentAssistantChars?: number;
  logging?: boolean;
  cacheTtlMs?: number;
  circuitBreakerMaxTimeouts?: number;
  circuitBreakerCooldownMs?: number;
  persistTranscripts?: boolean;
  transcriptDir?: string;
  qmd?: {
    searchMode?: ActiveMemoryQmdSearchMode;
  };
};

export type ResolvedActiveRecallPluginConfig = {
  enabled: boolean;
  agents: string[];
  model?: string;
  modelFallback?: string;
  modelFallbackPolicy: "default-remote" | "resolved-only";
  allowedChatTypes: Array<"direct" | "group" | "channel" | "explicit">;
  allowedChatIds: string[];
  deniedChatIds: string[];
  thinking: ActiveMemoryThinkingLevel;
  promptStyle: ActiveMemoryPromptStyle;
  toolsAllow: string[];
  promptOverride?: string;
  promptAppend?: string;
  timeoutMs: number;
  setupGraceTimeoutMs: number;
  queryMode: "message" | "recent" | "full";
  maxSummaryChars: number;
  recentUserTurns: number;
  recentAssistantTurns: number;
  recentUserChars: number;
  recentAssistantChars: number;
  logging: boolean;
  cacheTtlMs: number;
  circuitBreakerMaxTimeouts: number;
  circuitBreakerCooldownMs: number;
  persistTranscripts: boolean;
  transcriptDir: string;
  qmd: {
    searchMode: ActiveMemoryQmdSearchMode;
  };
};

export type ActiveRecallRecentTurn = {
  role: "user" | "assistant";
  text: string;
};
