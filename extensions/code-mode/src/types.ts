/**
 * Types for the code-mode plugin.
 */

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

/** Per-agent filtering: include or exclude specific agent IDs. */
export type AgentFilter = {
  /** If set, only these agent IDs will use this plugin. */
  include?: string[];
  /** If set, these agent IDs are excluded (ignored when `include` is set). */
  exclude?: string[];
};

/** Plugin-level config shape (from `plugins.code-mode` in openclaw config). */
export type CodeModePluginConfig = {
  /** Execution timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /** Whether to allow network access from sandbox code. */
  allowNetwork?: boolean;
  /** Per-agent opt-in/opt-out. Omit to enable for all agents. */
  agents?: AgentFilter;
};
