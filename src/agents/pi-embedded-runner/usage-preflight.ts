import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";
import {
  loadProviderUsageSummary,
  resolveUsageProviderId,
  type ProviderUsageSnapshot,
  type UsageProviderId,
  type UsageWindow,
} from "../../infra/provider-usage.js";

type UsagePreflightSnapshot = {
  providerId: UsageProviderId;
  window: UsageWindow;
  remainingPercent: number;
};

export type UsagePreflightDecision = {
  providerId?: UsageProviderId;
  blocked: boolean;
  warning: boolean;
  estimatedPromptTokens: number;
  remainingPercent?: number;
  windowLabel?: string;
  resetAt?: number;
};

const USAGE_PREFLIGHT_CACHE_TTL_MS = 60_000;
const WARN_REMAINING_PERCENT = 10;
const BLOCK_REMAINING_PERCENT = 2;
const ALWAYS_BLOCK_REMAINING_PERCENT = 1;
const BLOCK_MIN_ESTIMATED_PROMPT_TOKENS = 256;

const usageSnapshotCache = new Map<
  UsageProviderId,
  {
    snapshot: ProviderUsageSnapshot | null;
    expiresAt: number;
  }
>();

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function textTokenHeuristic(text: string): number {
  if (!text) {
    return 0;
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

function messageTextChars(message: AgentMessage): number {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }

  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      total += text.length;
      continue;
    }
    if ((block as { type?: unknown }).type === "image") {
      total += 1_024;
    }
  }
  return total;
}

function estimateMessageTokens(message: AgentMessage): number {
  try {
    const estimated = estimateTokens(message);
    if (Number.isFinite(estimated) && estimated > 0) {
      return Math.ceil(estimated);
    }
  } catch {
    // Fall back to char heuristics below.
  }
  return textTokenHeuristicByCharCount(messageTextChars(message));
}

function textTokenHeuristicByCharCount(charCount: number): number {
  if (!(charCount > 0)) {
    return 0;
  }
  return Math.max(1, Math.ceil(charCount / 4));
}

export function estimatePromptTokensForPreflight(params: {
  historyMessages: AgentMessage[];
  prompt: string;
}): number {
  let total = textTokenHeuristic(params.prompt);
  for (const message of params.historyMessages) {
    total += estimateMessageTokens(message);
  }
  return Math.max(1, total);
}

function pickMostExhaustedWindow(snapshot: ProviderUsageSnapshot): UsagePreflightSnapshot | null {
  if (snapshot.windows.length === 0) {
    return null;
  }
  let best: UsageWindow | undefined;
  let bestRemaining = Number.POSITIVE_INFINITY;
  for (const window of snapshot.windows) {
    const remaining = clampPercent(100 - window.usedPercent);
    if (!best || remaining < bestRemaining) {
      best = window;
      bestRemaining = remaining;
    }
  }
  if (!best) {
    return null;
  }
  return {
    providerId: snapshot.provider,
    window: best,
    remainingPercent: bestRemaining,
  };
}

async function loadSnapshotForProvider(params: {
  providerId: UsageProviderId;
  now: number;
  timeoutMs: number;
}): Promise<ProviderUsageSnapshot | null> {
  const cached = usageSnapshotCache.get(params.providerId);
  if (cached && cached.expiresAt > params.now) {
    return cached.snapshot;
  }

  try {
    const summary = await loadProviderUsageSummary({
      providers: [params.providerId],
      timeoutMs: params.timeoutMs,
      now: params.now,
    });
    const snapshot =
      summary.providers.find((entry) => entry.provider === params.providerId) ?? null;
    usageSnapshotCache.set(params.providerId, {
      snapshot,
      expiresAt: params.now + USAGE_PREFLIGHT_CACHE_TTL_MS,
    });
    return snapshot;
  } catch {
    return null;
  }
}

function formatResetHint(resetAt?: number, now: number = Date.now()): string | undefined {
  if (!resetAt || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const diffMs = Math.max(0, resetAt - now);
  if (diffMs <= 0) {
    return "resets now";
  }
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) {
    return `resets in ${diffMin}m`;
  }
  const hours = Math.floor(diffMin / 60);
  const minutes = diffMin % 60;
  if (hours < 24) {
    return minutes > 0 ? `resets in ${hours}h ${minutes}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `resets in ${days}d`;
}

function buildUserMessage(params: {
  providerId: UsageProviderId;
  remainingPercent: number;
  windowLabel: string;
  resetAt?: number;
  now: number;
}): string {
  const resetHint = formatResetHint(params.resetAt, params.now);
  const resetSuffix = resetHint ? ` (${resetHint})` : "";
  return (
    `Usage guard: request blocked to avoid hitting ${params.providerId} limits. ` +
    `About ${params.remainingPercent.toFixed(0)}% remains in the ${params.windowLabel} window${resetSuffix}. ` +
    "Switch model/provider/auth profile or wait for reset, then try again."
  );
}

export class UsagePreflightError extends Error {
  readonly details: UsagePreflightDecision;
  readonly userMessage: string;

  constructor(details: UsagePreflightDecision, userMessage: string) {
    super(userMessage);
    this.name = "UsagePreflightError";
    this.details = details;
    this.userMessage = userMessage;
  }
}

export function isUsagePreflightError(error: unknown): error is UsagePreflightError {
  return error instanceof UsagePreflightError;
}

export async function evaluateUsagePreflight(params: {
  provider?: string;
  prompt: string;
  historyMessages: AgentMessage[];
  now?: number;
  timeoutMs?: number;
}): Promise<UsagePreflightDecision> {
  const now = params.now ?? Date.now();
  const providerId = resolveUsageProviderId(params.provider);
  const estimatedPromptTokens = estimatePromptTokensForPreflight({
    historyMessages: params.historyMessages,
    prompt: params.prompt,
  });

  if (!providerId) {
    return {
      blocked: false,
      warning: false,
      estimatedPromptTokens,
    };
  }

  const timeoutMs =
    typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 1_500;
  const snapshot = await loadSnapshotForProvider({ providerId, now, timeoutMs });
  if (!snapshot || snapshot.error) {
    return {
      providerId,
      blocked: false,
      warning: false,
      estimatedPromptTokens,
    };
  }

  const exhausted = pickMostExhaustedWindow(snapshot);
  if (!exhausted) {
    return {
      providerId,
      blocked: false,
      warning: false,
      estimatedPromptTokens,
    };
  }

  const remaining = exhausted.remainingPercent;
  const warning = remaining <= WARN_REMAINING_PERCENT;
  const blocked =
    remaining <= ALWAYS_BLOCK_REMAINING_PERCENT ||
    (remaining <= BLOCK_REMAINING_PERCENT &&
      estimatedPromptTokens >= BLOCK_MIN_ESTIMATED_PROMPT_TOKENS);

  return {
    providerId,
    blocked,
    warning,
    estimatedPromptTokens,
    remainingPercent: remaining,
    windowLabel: exhausted.window.label,
    resetAt: exhausted.window.resetAt,
  };
}

export function usagePreflightDecisionMessage(
  decision: UsagePreflightDecision,
  now: number = Date.now(),
): string | undefined {
  if (!decision.providerId || decision.remainingPercent === undefined || !decision.windowLabel) {
    return undefined;
  }
  return buildUserMessage({
    providerId: decision.providerId,
    remainingPercent: decision.remainingPercent,
    windowLabel: decision.windowLabel,
    resetAt: decision.resetAt,
    now,
  });
}

export function _resetUsagePreflightCacheForTests(): void {
  usageSnapshotCache.clear();
}
