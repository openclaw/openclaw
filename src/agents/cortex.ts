import type { OpenClawConfig } from "../config/config.js";
import type { AgentCortexConfig } from "../config/types.agent-defaults.js";
import { getCortexModeOverride } from "../memory/cortex-mode-overrides.js";
import {
  getCortexStatus,
  ingestCortexMemoryFromText,
  listCortexMemoryConflicts,
  previewCortexContext,
  syncCortexCodingContext,
  type CortexPolicy,
  type CortexStatus,
} from "../memory/cortex.js";
import { resolveAgentConfig } from "./agent-scope.js";
import {
  appendCortexCaptureHistory,
  getLatestCortexCaptureHistoryEntry,
} from "./cortex-history.js";

export type ResolvedAgentCortexConfig = {
  enabled: true;
  graphPath?: string;
  mode: CortexPolicy;
  maxChars: number;
};

export type AgentCortexPromptContextResult = {
  context?: string;
  error?: string;
};

export type ResolvedAgentCortexModeStatus = {
  enabled: true;
  mode: CortexPolicy;
  source: "agent-config" | "session-override" | "channel-override";
  graphPath?: string;
  maxChars: number;
};

export type ResolvedAgentTurnCortexContext = {
  config: ResolvedAgentCortexModeStatus;
  status: CortexStatus;
};

export type AgentCortexConflictNotice = {
  text: string;
  conflictId: string;
  severity: number;
};

export type AgentCortexMemoryCaptureResult = {
  captured: boolean;
  score: number;
  reason: string;
  error?: string;
  syncedCodingContext?: boolean;
  syncPlatforms?: string[];
};

export type AgentCortexMemoryCaptureStatus = AgentCortexMemoryCaptureResult & {
  updatedAt: number;
};

const DEFAULT_CORTEX_MODE: CortexPolicy = "technical";
const DEFAULT_CORTEX_MAX_CHARS = 1_500;
const MAX_CORTEX_MAX_CHARS = 8_000;
const DEFAULT_CORTEX_CONFLICT_SEVERITY = 0.75;
const DEFAULT_CORTEX_CONFLICT_COOLDOWN_MS = 30 * 60 * 1000;
const cortexConflictNoticeCooldowns = new Map<string, number>();
const cortexMemoryCaptureStatuses = new Map<string, AgentCortexMemoryCaptureStatus>();
const MIN_CORTEX_MEMORY_CONTENT_LENGTH = 24;
const DEFAULT_CORTEX_CODING_SYNC_COOLDOWN_MS = 10 * 60 * 1000;
const LOW_SIGNAL_PATTERNS = [
  /^ok[.!]?$/i,
  /^okay[.!]?$/i,
  /^thanks?[.!]?$/i,
  /^cool[.!]?$/i,
  /^sounds good[.!]?$/i,
  /^yes[.!]?$/i,
  /^no[.!]?$/i,
  /^lol[.!]?$/i,
  /^haha[.!]?$/i,
  /^test$/i,
];
const HIGH_SIGNAL_PATTERNS = [
  /\bI prefer\b/i,
  /\bmy preference\b/i,
  /\bI am working on\b/i,
  /\bI’m working on\b/i,
  /\bmy project\b/i,
  /\bI use\b/i,
  /\bI don't use\b/i,
  /\bI do not use\b/i,
  /\bI need\b/i,
  /\bmy goal\b/i,
  /\bmy priority\b/i,
  /\bremember that\b/i,
  /\bI like\b/i,
  /\bI dislike\b/i,
  /\bI am focused on\b/i,
  /\bI'm focused on\b/i,
  /\bI've been focused on\b/i,
  /\bI work with\b/i,
  /\bI work on\b/i,
];
const TECHNICAL_SIGNAL_PATTERNS = [
  /\bpython\b/i,
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\brepo\b/i,
  /\bbug\b/i,
  /\bdebug\b/i,
  /\bdeploy\b/i,
  /\bpr\b/i,
  /\bcursor\b/i,
  /\bcopilot\b/i,
  /\bclaude code\b/i,
  /\bgemini\b/i,
  /\bapi\b/i,
  /\bbackend\b/i,
];
const STRONG_CODING_SYNC_PATTERNS = [
  /\brepo\b/i,
  /\bcodebase\b/i,
  /\bpull request\b/i,
  /\bpackage\.json\b/i,
  /\btsconfig\b/i,
  /\bpytest\b/i,
  /\bclaude code\b/i,
  /\bcursor\b/i,
  /\bcopilot\b/i,
  /\bgemini cli\b/i,
];
const CORTEX_CODING_PROVIDER_PLATFORM_MAP: Record<string, string[]> = {
  "claude-code": ["claude-code"],
  copilot: ["copilot"],
  cursor: ["cursor"],
  "gemini-cli": ["gemini-cli"],
};
const CORTEX_MESSAGING_PROVIDERS = new Set([
  "discord",
  "imessage",
  "signal",
  "slack",
  "telegram",
  "voice",
  "webchat",
  "whatsapp",
]);
const cortexCodingSyncCooldowns = new Map<string, number>();

function normalizeMode(mode?: AgentCortexConfig["mode"]): CortexPolicy {
  if (mode === "full" || mode === "professional" || mode === "technical" || mode === "minimal") {
    return mode;
  }
  return DEFAULT_CORTEX_MODE;
}

function normalizeMaxChars(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_CORTEX_MAX_CHARS;
  }
  return Math.min(MAX_CORTEX_MAX_CHARS, Math.max(1, Math.floor(value)));
}

export function resolveAgentCortexConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentCortexConfig | null {
  const defaults = cfg.agents?.defaults?.cortex;
  const overrides = resolveAgentConfig(cfg, agentId)?.cortex;
  const enabled = overrides?.enabled ?? defaults?.enabled ?? false;
  if (!enabled) {
    return null;
  }
  return {
    enabled: true,
    graphPath: overrides?.graphPath ?? defaults?.graphPath,
    mode: normalizeMode(overrides?.mode ?? defaults?.mode),
    maxChars: normalizeMaxChars(overrides?.maxChars ?? defaults?.maxChars),
  };
}

export function resolveCortexChannelTarget(params: {
  channel?: string;
  channelId?: string;
  originatingChannel?: string;
  originatingTo?: string;
  nativeChannelId?: string;
  to?: string;
  from?: string;
}): string {
  const directConversationId = params.originatingTo?.trim();
  if (directConversationId) {
    return directConversationId;
  }
  const nativeConversationId = params.nativeChannelId?.trim();
  if (nativeConversationId) {
    return nativeConversationId;
  }
  const destinationId = params.to?.trim();
  if (destinationId) {
    return destinationId;
  }
  const sourceId = params.from?.trim();
  if (sourceId) {
    return sourceId;
  }
  const providerChannelId = params.channelId?.trim();
  if (providerChannelId) {
    return providerChannelId;
  }
  return String(params.originatingChannel ?? params.channel ?? "").trim();
}

export async function resolveAgentCortexModeStatus(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): Promise<ResolvedAgentCortexModeStatus | null> {
  if (!params.cfg) {
    return null;
  }
  const cortex = resolveAgentCortexConfig(params.cfg, params.agentId);
  if (!cortex) {
    return null;
  }
  const modeOverride = await getCortexModeOverride({
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
  });
  return {
    enabled: true,
    graphPath: cortex.graphPath,
    maxChars: cortex.maxChars,
    mode: modeOverride?.mode ?? cortex.mode,
    source:
      modeOverride?.scope === "session"
        ? "session-override"
        : modeOverride?.scope === "channel"
          ? "channel-override"
          : "agent-config",
  };
}

export async function resolveAgentCortexPromptContext(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  promptMode: "full" | "minimal";
  sessionId?: string;
  channelId?: string;
  resolved?: ResolvedAgentTurnCortexContext | null;
}): Promise<AgentCortexPromptContextResult> {
  if (!params.cfg || params.promptMode !== "full") {
    return {};
  }
  const resolved =
    params.resolved ??
    (await resolveAgentTurnCortexContext({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      channelId: params.channelId,
    }));
  if (!resolved) {
    return {};
  }
  try {
    const preview = await previewCortexContext({
      workspaceDir: params.workspaceDir,
      graphPath: resolved.config.graphPath,
      policy: resolved.config.mode,
      maxChars: resolved.config.maxChars,
      status: resolved.status,
    });
    return preview.context ? { context: preview.context } : {};
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveAgentTurnCortexContext(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  sessionId?: string;
  channelId?: string;
}): Promise<ResolvedAgentTurnCortexContext | null> {
  if (!params.cfg) {
    return null;
  }
  const config = await resolveAgentCortexModeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
  });
  if (!config) {
    return null;
  }
  const status = await getCortexStatus({
    workspaceDir: params.workspaceDir,
    graphPath: config.graphPath,
  });
  return { config, status };
}

export function resetAgentCortexConflictNoticeStateForTests(): void {
  cortexConflictNoticeCooldowns.clear();
  cortexMemoryCaptureStatuses.clear();
  cortexCodingSyncCooldowns.clear();
}

function buildAgentCortexConversationKey(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): string {
  return [params.agentId, params.sessionId ?? "", params.channelId ?? ""].join(":");
}

export function getAgentCortexMemoryCaptureStatus(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): AgentCortexMemoryCaptureStatus | null {
  const key = buildAgentCortexConversationKey({
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
  });
  return cortexMemoryCaptureStatuses.get(key) ?? null;
}

function scoreAgentCortexMemoryCandidate(commandBody: string): AgentCortexMemoryCaptureResult {
  const content = commandBody.trim();
  if (!content) {
    return { captured: false, score: 0, reason: "empty content" };
  }
  if (content.startsWith("/") || content.startsWith("!")) {
    return { captured: false, score: 0, reason: "command content" };
  }
  if (LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(content))) {
    return { captured: false, score: 0.05, reason: "low-signal short reply" };
  }
  let score = 0.1;
  if (content.length >= MIN_CORTEX_MEMORY_CONTENT_LENGTH) {
    score += 0.2;
  }
  if (content.length >= 80) {
    score += 0.1;
  }
  if (HIGH_SIGNAL_PATTERNS.some((pattern) => pattern.test(content))) {
    score += 0.4;
  }
  if (TECHNICAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(content))) {
    score += 0.2;
  }
  const captured = score >= 0.45;
  return {
    captured,
    score,
    reason: captured ? "high-signal memory candidate" : "below memory threshold",
  };
}

function resolveAutoSyncCortexCodingContext(params: {
  commandBody: string;
  provider?: string;
}): { policy: CortexPolicy; platforms: string[] } | null {
  if (!TECHNICAL_SIGNAL_PATTERNS.some((pattern) => pattern.test(params.commandBody))) {
    return null;
  }

  const provider = params.provider?.trim().toLowerCase();
  if (provider) {
    const directPlatforms = CORTEX_CODING_PROVIDER_PLATFORM_MAP[provider];
    if (directPlatforms) {
      return {
        policy: "technical",
        platforms: directPlatforms,
      };
    }
  }

  const hasStrongCodingIntent = STRONG_CODING_SYNC_PATTERNS.some((pattern) =>
    pattern.test(params.commandBody),
  );
  if (provider && CORTEX_MESSAGING_PROVIDERS.has(provider) && !hasStrongCodingIntent) {
    return null;
  }

  return {
    policy: "technical",
    platforms: ["claude-code", "cursor", "copilot"],
  };
}

export async function resolveAgentCortexConflictNotice(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  sessionId?: string;
  channelId?: string;
  minSeverity?: number;
  now?: number;
  cooldownMs?: number;
  resolved?: ResolvedAgentTurnCortexContext | null;
}): Promise<AgentCortexConflictNotice | null> {
  if (!params.cfg) {
    return null;
  }
  const resolved =
    params.resolved ??
    (await resolveAgentTurnCortexContext({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      channelId: params.channelId,
    }));
  if (!resolved) {
    return null;
  }
  const targetKey = buildAgentCortexConversationKey({
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
  });
  const now = params.now ?? Date.now();
  const cooldownMs = params.cooldownMs ?? DEFAULT_CORTEX_CONFLICT_COOLDOWN_MS;
  const nextAllowedAt = cortexConflictNoticeCooldowns.get(targetKey) ?? 0;
  if (nextAllowedAt > now) {
    return null;
  }
  try {
    const conflicts = await listCortexMemoryConflicts({
      workspaceDir: params.workspaceDir,
      graphPath: resolved.config.graphPath,
      minSeverity: params.minSeverity ?? DEFAULT_CORTEX_CONFLICT_SEVERITY,
      status: resolved.status,
    });
    const topConflict = conflicts
      .filter((entry) => entry.id && entry.summary)
      .toSorted((left, right) => right.severity - left.severity)[0];
    if (!topConflict) {
      cortexConflictNoticeCooldowns.set(targetKey, now + cooldownMs);
      return null;
    }
    cortexConflictNoticeCooldowns.set(targetKey, now + cooldownMs);
    return {
      conflictId: topConflict.id,
      severity: topConflict.severity,
      text: [
        `⚠️ Cortex conflict detected: ${topConflict.summary}`,
        `Resolve with: /cortex resolve ${topConflict.id} <accept-new|keep-old|merge|ignore>`,
      ].join("\n"),
    };
  } catch {
    cortexConflictNoticeCooldowns.set(targetKey, now + cooldownMs);
    return null;
  }
}

export async function ingestAgentCortexMemoryCandidate(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  commandBody: string;
  sessionId?: string;
  channelId?: string;
  provider?: string;
  resolved?: ResolvedAgentTurnCortexContext | null;
}): Promise<AgentCortexMemoryCaptureResult> {
  const conversationKey = buildAgentCortexConversationKey({
    agentId: params.agentId,
    sessionId: params.sessionId,
    channelId: params.channelId,
  });
  if (!params.cfg) {
    const result = { captured: false, score: 0, reason: "missing config" };
    cortexMemoryCaptureStatuses.set(conversationKey, { ...result, updatedAt: Date.now() });
    return result;
  }
  const resolved =
    params.resolved ??
    (await resolveAgentTurnCortexContext({
      cfg: params.cfg,
      agentId: params.agentId,
      workspaceDir: params.workspaceDir,
      sessionId: params.sessionId,
      channelId: params.channelId,
    }));
  if (!resolved) {
    const result = { captured: false, score: 0, reason: "cortex disabled" };
    cortexMemoryCaptureStatuses.set(conversationKey, { ...result, updatedAt: Date.now() });
    return result;
  }
  const decision = scoreAgentCortexMemoryCandidate(params.commandBody);
  if (!decision.captured) {
    cortexMemoryCaptureStatuses.set(conversationKey, { ...decision, updatedAt: Date.now() });
    return decision;
  }
  try {
    await ingestCortexMemoryFromText({
      workspaceDir: params.workspaceDir,
      graphPath: resolved.config.graphPath,
      event: {
        actor: "user",
        text: params.commandBody,
        agentId: params.agentId,
        sessionId: params.sessionId,
        channelId: params.channelId,
        provider: params.provider,
      },
      status: resolved.status,
    });
    let syncedCodingContext = false;
    let syncPlatforms: string[] | undefined;
    const syncPolicy = resolveAutoSyncCortexCodingContext({
      commandBody: params.commandBody,
      provider: params.provider,
    });
    if (syncPolicy) {
      const nextAllowedAt = cortexCodingSyncCooldowns.get(conversationKey) ?? 0;
      const now = Date.now();
      if (nextAllowedAt <= now) {
        try {
          const syncResult = await syncCortexCodingContext({
            workspaceDir: params.workspaceDir,
            graphPath: resolved.config.graphPath,
            policy: syncPolicy.policy,
            platforms: syncPolicy.platforms,
            status: resolved.status,
          });
          syncedCodingContext = true;
          syncPlatforms = syncResult.platforms;
          cortexCodingSyncCooldowns.set(
            conversationKey,
            now + DEFAULT_CORTEX_CODING_SYNC_COOLDOWN_MS,
          );
        } catch {
          syncedCodingContext = false;
        }
      }
    }
    const result = { ...decision, syncedCodingContext, syncPlatforms };
    const updatedAt = Date.now();
    cortexMemoryCaptureStatuses.set(conversationKey, { ...result, updatedAt });
    await appendCortexCaptureHistory({
      agentId: params.agentId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      captured: result.captured,
      score: result.score,
      reason: result.reason,
      syncedCodingContext: result.syncedCodingContext,
      syncPlatforms: result.syncPlatforms,
      timestamp: updatedAt,
    }).catch(() => {});
    return result;
  } catch (error) {
    const result = {
      captured: false,
      score: decision.score,
      reason: decision.reason,
      error: error instanceof Error ? error.message : String(error),
    };
    const updatedAt = Date.now();
    cortexMemoryCaptureStatuses.set(conversationKey, { ...result, updatedAt });
    await appendCortexCaptureHistory({
      agentId: params.agentId,
      sessionId: params.sessionId,
      channelId: params.channelId,
      captured: result.captured,
      score: result.score,
      reason: result.reason,
      error: result.error,
      timestamp: updatedAt,
    }).catch(() => {});
    return result;
  }
}

export async function getAgentCortexMemoryCaptureStatusWithHistory(params: {
  agentId: string;
  sessionId?: string;
  channelId?: string;
}): Promise<AgentCortexMemoryCaptureStatus | null> {
  const live = getAgentCortexMemoryCaptureStatus(params);
  if (live) {
    return live;
  }
  const fromHistory = await getLatestCortexCaptureHistoryEntry(params).catch(() => null);
  if (!fromHistory) {
    return null;
  }
  return {
    captured: fromHistory.captured,
    score: fromHistory.score,
    reason: fromHistory.reason,
    error: fromHistory.error,
    syncedCodingContext: fromHistory.syncedCodingContext,
    syncPlatforms: fromHistory.syncPlatforms,
    updatedAt: fromHistory.timestamp,
  };
}
