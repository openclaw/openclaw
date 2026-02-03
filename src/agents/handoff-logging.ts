import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentWorkspaceDir } from "./agent-scope.js";

const logger = createSubsystemLogger("agent/handoff");

// ============================================================================
// Types
// ============================================================================

export type HandoffLoggingOptions = {
  /** Enable handoff logging (default: from config). */
  enabled?: boolean;
  /** Log level for handoff events (default: "info"). */
  level?: "debug" | "info" | "warn";
};

type AgentInfo = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  workspaceLocation: string;
};

type InheritedContext = {
  channel?: string;
  accountId?: string;
  threadId?: string | number;
  modelOverride?: string;
  thinkingOverride?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  cleanup?: "delete" | "keep";
  label?: string;
  runTimeoutSeconds?: number;
};

type HandoffStats = {
  runtimeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: string;
};

// ============================================================================
// Configuration Helpers
// ============================================================================

export function shouldLogHandoff(
  config?: OpenClawConfig,
  options?: HandoffLoggingOptions,
): boolean {
  // Priority: runtime options > config > default (false)
  if (options?.enabled !== undefined) {
    return options.enabled;
  }
  return config?.agents?.handoffLogging?.enabled ?? false;
}

export function resolveHandoffLogLevel(
  config?: OpenClawConfig,
  options?: HandoffLoggingOptions,
): "debug" | "info" | "warn" {
  if (options?.level) {
    return options.level;
  }
  return config?.agents?.handoffLogging?.level ?? "info";
}

// ============================================================================
// Workspace & Session Resolution
// ============================================================================

export function resolveWorkspaceLocationFromSessionKey(sessionKey: string): string {
  const cfg = loadConfig();
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.agentId) {
    return "(unknown)";
  }
  try {
    return resolveAgentWorkspaceDir(cfg, parsed.agentId);
  } catch {
    return "(error resolving workspace)";
  }
}

export function resolveSessionIdFromKey(sessionKey: string): string {
  const cfg = loadConfig();
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.agentId) {
    return "(unknown)";
  }

  try {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: parsed.agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    return entry?.sessionId ?? "(pending)";
  } catch {
    return "(unknown)";
  }
}

function buildAgentInfo(sessionKey: string): AgentInfo {
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? "unknown";

  return {
    agentId,
    sessionId: resolveSessionIdFromKey(sessionKey),
    sessionKey,
    workspaceLocation: resolveWorkspaceLocationFromSessionKey(sessionKey),
  };
}

// ============================================================================
// Logging Functions
// ============================================================================

export function logHandoffSpawn(params: {
  fromSessionKey: string;
  toSessionKey: string;
  task: string;
  contextInherited?: InheritedContext;
  options?: HandoffLoggingOptions;
}): void {
  const cfg = loadConfig();
  if (!shouldLogHandoff(cfg, params.options)) {
    return;
  }

  const level = resolveHandoffLogLevel(cfg, params.options);
  const from = buildAgentInfo(params.fromSessionKey);
  const to = buildAgentInfo(params.toSessionKey);

  const logData = {
    event: "agent.handoff.spawn",
    from,
    to,
    reason: params.task,
    contextInherited: params.contextInherited ?? {},
    timestamp: new Date().toISOString(),
  };

  logger[level]("Agent handoff spawn", logData);
}

export function logHandoffComplete(params: {
  fromSessionKey: string;
  toSessionKey: string;
  outcome: { status: "ok" | "error" | "timeout" | "unknown"; error?: string };
  stats?: HandoffStats;
  options?: HandoffLoggingOptions;
}): void {
  const cfg = loadConfig();
  if (!shouldLogHandoff(cfg, params.options)) {
    return;
  }

  const level = resolveHandoffLogLevel(cfg, params.options);
  const from = buildAgentInfo(params.fromSessionKey);
  const to = buildAgentInfo(params.toSessionKey);

  const logData = {
    event: "agent.handoff.complete",
    from,
    to,
    outcome: params.outcome,
    stats: params.stats ?? {},
    timestamp: new Date().toISOString(),
  };

  logger[level]("Agent handoff complete", logData);
}
