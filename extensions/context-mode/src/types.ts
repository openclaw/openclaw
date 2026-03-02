/**
 * Shared types for the context-mode plugin.
 */

/** Per-agent filtering: include or exclude specific agent IDs. */
export type AgentFilter = {
  /** If set, only these agent IDs will use this plugin. */
  include?: string[];
  /** If set, these agent IDs are excluded (ignored when `include` is set). */
  exclude?: string[];
};

export type ContextModeConfig = {
  /** Enable proactive tool-output compression (default: false). */
  enabled: boolean;
  /** Character threshold below which results pass through unchanged (default: 2000). */
  threshold: number;
  /** Tool names excluded from compression. */
  excludeTools: string[];
  /** Maximum characters to keep in the compressed summary head (default: 500). */
  summaryHeadChars: number;
  /** Per-agent opt-in/opt-out. Omit to enable for all agents. */
  agents?: AgentFilter;
};

export const DEFAULT_CONFIG: ContextModeConfig = {
  enabled: false,
  threshold: 2000,
  excludeTools: [],
  summaryHeadChars: 500,
};

export type CompressedEntry = {
  /** Unique reference ID for retrieval. */
  refId: string;
  /** Tool that produced the original output. */
  toolName: string;
  /** Tool call ID from the agent framework. */
  toolCallId: string;
  /** Original character count. */
  originalChars: number;
  /** Compressed character count. */
  compressedChars: number;
  /** The full original text, stored for later retrieval. */
  fullText: string;
  /** Timestamp of compression. */
  timestamp: number;
};

export type CompressionResult = {
  /** The compressed summary text to replace the original. */
  summary: string;
  /** Reference ID for retrieval from the knowledge base. */
  refId: string;
  /** Original character count. */
  originalChars: number;
};

export type RecentEntry = {
  refId: string;
  toolName: string;
  toolCallId: string;
  originalChars: number;
  compressedChars: number;
  timestamp: number;
};
