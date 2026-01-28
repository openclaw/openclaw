/**
 * AgentRuntime — common interface for agent execution backends.
 *
 * Both the Pi Agent and the Claude Code SDK Agent implement this interface,
 * allowing the dispatch layer to swap runtimes without changing downstream
 * reply pipeline code.
 */

import type { ClawdbrainConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

// ---------------------------------------------------------------------------
// Runtime discriminant
// ---------------------------------------------------------------------------

/** Discriminant for the active agent runtime backend. */
export type AgentRuntimeKind = "pi" | "sdk";

// ---------------------------------------------------------------------------
// Shared callback types
// ---------------------------------------------------------------------------

/** Streaming callbacks shared by all agent runtimes. */
export type AgentRuntimeCallbacks = {
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onToolResult?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
};

// ---------------------------------------------------------------------------
// Common run parameters
// ---------------------------------------------------------------------------

/** Parameters shared by all agent runtimes for a single run. */
export type AgentRuntimeRunParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: ClawdbrainConfig;
  prompt: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
} & AgentRuntimeCallbacks;

// ---------------------------------------------------------------------------
// Result type (same shape for all runtimes)
// ---------------------------------------------------------------------------

/**
 * All runtimes produce `EmbeddedPiRunResult` so the downstream reply
 * pipeline can consume results without knowing which runtime produced them.
 */
export type AgentRuntimeResult = EmbeddedPiRunResult;

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Common interface for agent execution backends.
 *
 * Implementations capture runtime-specific configuration at construction
 * time (via factory functions), then expose a single `run()` method that
 * accepts only the common parameters shared across all runtimes.
 */
export interface AgentRuntime {
  /** Discriminant identifying which backend is active. */
  readonly kind: AgentRuntimeKind;

  /** Human-readable name for logging and diagnostics. */
  readonly displayName: string;

  /** Execute the agent with the given parameters. */
  run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult>;
}
