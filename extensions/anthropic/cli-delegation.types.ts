import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * Result of probing the Claude CLI for auth status.
 */
export type ClaudeCliStatus =
  | { installed: false; reason?: string }
  | { installed: true; authenticated: false; reason: string }
  | {
      installed: true;
      authenticated: true;
      subscriptionType?: string;
      authMethod?: "apiKey" | "subscription";
    };

/**
 * Configuration for creating a Claude SDK session.
 */
export interface ClaudeSessionConfig {
  binaryPath: string;
  cwd: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  permissionMode?: PermissionMode;
  resumeSessionId?: string;
  newSessionId?: string;
  settingSources?: Array<"user" | "project" | "local">;
}

/**
 * Adapted message from the SDK stream into OpenClaw's format.
 */
export type AdaptedMessage =
  | { kind: "text_delta"; text: string }
  | { kind: "thinking_delta"; text: string }
  | { kind: "tool_use"; name: string; input: unknown }
  | { kind: "result"; status: string; sessionId?: string; usage?: TokenUsage }
  | { kind: "auth_status"; authenticated: boolean }
  | { kind: "rate_limit"; retryAfterMs?: number }
  | { kind: "ignored" };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

/**
 * Sentinel token stored in auth profiles to signal CLI delegation.
 * This value is never sent to any API.
 */
export const CLI_DELEGATION_SENTINEL = "__cli_delegation__";

/**
 * Auth method ID for the CLI delegation path.
 */
export const CLI_DELEGATION_AUTH_METHOD_ID = "claude-code-cli-delegation";

/**
 * Profile ID for the CLI delegation auth profile.
 */
export const CLI_DELEGATION_PROFILE_ID = "anthropic:claude-code-cli-delegation";
