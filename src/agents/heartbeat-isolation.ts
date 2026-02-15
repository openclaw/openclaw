import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/heartbeat-isolation");

export type HeartbeatIsolationConfig = {
  /** Run heartbeats in isolated micro-sessions without full session context. */
  isolated: boolean;
  /** Model to use for heartbeat runs. */
  model: string;
  /** Max tokens for heartbeat response. */
  maxTokens: number;
};

const DEFAULT_CONFIG: HeartbeatIsolationConfig = {
  isolated: true,
  model: "anthropic/claude-haiku",
  maxTokens: 2000,
};

export function resolveHeartbeatIsolationConfig(cfg?: OpenClawConfig): HeartbeatIsolationConfig {
  const heartbeat = cfg?.agents?.defaults?.heartbeat as Record<string, unknown> | undefined;
  if (!heartbeat) {
    return DEFAULT_CONFIG;
  }

  return {
    isolated:
      typeof heartbeat.isolated === "boolean" ? heartbeat.isolated : DEFAULT_CONFIG.isolated,
    model: typeof heartbeat.model === "string" ? heartbeat.model : DEFAULT_CONFIG.model,
    maxTokens:
      typeof heartbeat.maxTokens === "number" ? heartbeat.maxTokens : DEFAULT_CONFIG.maxTokens,
  };
}

/**
 * Build a minimal system prompt for isolated heartbeat sessions.
 * Includes only HEARTBEAT.md content and essential context.
 * No skills, no full conversation history.
 */
export function buildIsolatedHeartbeatPrompt(params: {
  heartbeatMd?: string;
  agentId?: string;
  workspaceDir?: string;
  userTimezone?: string;
  currentTime?: string;
}): string {
  const sections: string[] = [];

  sections.push("You are running a periodic heartbeat check.");
  sections.push("This is an isolated micro-session with minimal context.");
  sections.push("If an action is needed, use sessions_send to announce back to the main session.");

  if (params.agentId) {
    sections.push(`\nAgent: ${params.agentId}`);
  }
  if (params.workspaceDir) {
    sections.push(`Workspace: ${params.workspaceDir}`);
  }
  if (params.currentTime) {
    sections.push(`Current time: ${params.currentTime}`);
  }
  if (params.userTimezone) {
    sections.push(`Timezone: ${params.userTimezone}`);
  }

  if (params.heartbeatMd?.trim()) {
    sections.push("\n## HEARTBEAT.md\n");
    sections.push(params.heartbeatMd.trim());
  } else {
    sections.push("\nNo HEARTBEAT.md found. Reply HEARTBEAT_OK if nothing needs attention.");
  }

  return sections.join("\n");
}

/**
 * Determine if a heartbeat response indicates action is needed
 * (i.e., should announce back to main session).
 */
export function heartbeatNeedsAction(response: string): boolean {
  const trimmed = response.trim().toUpperCase();
  // If the response is just HEARTBEAT_OK (optionally with minimal trailing text),
  // no action is needed.
  if (trimmed === "HEARTBEAT_OK" || trimmed.startsWith("HEARTBEAT_OK")) {
    const afterOk = trimmed.slice("HEARTBEAT_OK".length).trim();
    // Allow small acknowledgment text (under 30 chars)
    if (afterOk.length <= 30) {
      return false;
    }
  }
  return trimmed.length > 0;
}

/**
 * Build the announce-back message for a heartbeat that needs action.
 */
export function buildHeartbeatAnnouncement(params: {
  heartbeatResponse: string;
  sessionKey: string;
}): string {
  return `[Heartbeat action needed]\nSession: ${params.sessionKey}\n\n${params.heartbeatResponse}`;
}

/**
 * Check if a session key represents a heartbeat session.
 */
export function isHeartbeatSession(sessionKey: string): boolean {
  return sessionKey.includes(":heartbeat") || sessionKey.includes("heartbeat:");
}

/**
 * Log heartbeat isolation decision.
 */
export function logHeartbeatIsolation(params: {
  sessionKey: string;
  isolated: boolean;
  model: string;
}): void {
  if (params.isolated) {
    log.info(
      `heartbeat running in isolated mode: session=${params.sessionKey} model=${params.model}`,
    );
  } else {
    log.debug(`heartbeat running in standard mode: session=${params.sessionKey}`);
  }
}
