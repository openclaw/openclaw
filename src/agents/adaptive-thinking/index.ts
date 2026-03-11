import { normalizeThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveThinkingDefault, type ThinkLevel } from "../model-selection.js";

export type AdaptiveThinkingSignal =
  | "attachments"
  | "coding"
  | "debugging"
  | "high_stakes"
  | "long_context"
  | "multi_step"
  | "planning"
  | "tool_likely";

export type AdaptiveThinkingDecision = {
  thinkingLevel: ThinkLevel;
  confidence: number;
  reason?: string;
  signals: AdaptiveThinkingSignal[];
};

export type AdaptiveThinkingDecisionValidation =
  | { ok: true; decision: AdaptiveThinkingDecision }
  | { ok: false; reason: string };

export type AdaptiveThinkingContextBundle = {
  currentMessage: string;
  recentMessages: string[];
  attachmentCount: number;
  currentThinkingDefault: ThinkLevel;
  signals: AdaptiveThinkingSignal[];
};

export type AdaptiveThinkingResolution = {
  thinkingLevel: ThinkLevel;
  source: "explicit_override" | "session_override" | "adaptive" | "thinking_default";
  confidence?: number;
  reason?: string;
  signals?: AdaptiveThinkingSignal[];
};

export type AdaptiveThinkingConfig = {
  enabled?: boolean;
  confidenceThreshold?: number;
  timeoutMs?: number;
  evaluatorModel?: string;
  recentMessages?: number;
};

const THINKING_LEVELS: ThinkLevel[] = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "adaptive",
]);

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.max(0, Math.min(1, value));
}

function dedupeSignals(signals: AdaptiveThinkingSignal[]): AdaptiveThinkingSignal[] {
  return [...new Set(signals)];
}

export function normalizeAdaptiveThinkingDecision(
  value: unknown,
): AdaptiveThinkingDecisionValidation {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "decision must be an object" };
  }
  const candidate = value as {
    thinkingLevel?: unknown;
    confidence?: unknown;
    reason?: unknown;
    signals?: unknown;
  };
  const thinkingLevel = normalizeThinkLevel(
    typeof candidate.thinkingLevel === "string" ? candidate.thinkingLevel : undefined,
  );
  if (!thinkingLevel || !THINKING_LEVELS.has(thinkingLevel)) {
    return { ok: false, reason: "invalid thinkingLevel" };
  }
  const confidence = clampConfidence(
    typeof candidate.confidence === "number" ? candidate.confidence : Number.NaN,
  );
  if (!Number.isFinite(confidence)) {
    return { ok: false, reason: "invalid confidence" };
  }
  const signals = Array.isArray(candidate.signals)
    ? dedupeSignals(
        candidate.signals.filter(
          (entry): entry is AdaptiveThinkingSignal =>
            typeof entry === "string" &&
            [
              "attachments",
              "coding",
              "debugging",
              "high_stakes",
              "long_context",
              "multi_step",
              "planning",
              "tool_likely",
            ].includes(entry),
        ),
      )
    : [];
  return {
    ok: true,
    decision: {
      thinkingLevel,
      confidence,
      reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
      signals,
    },
  };
}

export function buildAdaptiveThinkingContextBundle(params: {
  currentMessage: string;
  recentMessages?: string[];
  attachmentCount?: number;
  currentThinkingDefault: ThinkLevel;
  recentMessagesLimit?: number;
}): AdaptiveThinkingContextBundle {
  const trimmed = params.currentMessage.trim();
  const recentMessages = (params.recentMessages ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-(params.recentMessagesLimit ?? 3));
  const lower = [trimmed, ...recentMessages].join("\n").toLowerCase();
  const signals: AdaptiveThinkingSignal[] = [];
  if (params.attachmentCount && params.attachmentCount > 0) {
    signals.push("attachments");
  }
  if (
    /(fix|bug|debug|failing test|stack trace|traceback|regression|why is|root cause|broken)/i.test(
      lower,
    )
  ) {
    signals.push("debugging", "tool_likely", "multi_step");
  }
  if (
    /(implement|refactor|function|class|typescript|javascript|python|regex|sql|api|repo|file)/i.test(
      lower,
    )
  ) {
    signals.push("coding", "tool_likely");
  }
  if (/(plan|design|architecture|strategy|approach|proposal|spec)/i.test(lower)) {
    signals.push("planning", "multi_step");
  }
  if (
    /(carefully|important|production|risk|urgent|security|migration|database|data loss)/i.test(
      lower,
    )
  ) {
    signals.push("high_stakes", "multi_step");
  }
  if (trimmed.length > 900 || recentMessages.join("\n").length > 1200) {
    signals.push("long_context");
  }
  return {
    currentMessage: trimmed,
    recentMessages,
    attachmentCount: params.attachmentCount ?? 0,
    currentThinkingDefault: params.currentThinkingDefault,
    signals: dedupeSignals(signals),
  };
}

export async function evaluateAdaptiveThinking(params: {
  config?: AdaptiveThinkingConfig;
  bundle: AdaptiveThinkingContextBundle;
  disabled?: boolean;
}): Promise<
  | { kind: "skipped"; reason: string }
  | { kind: "decision"; decision: AdaptiveThinkingDecision }
  | { kind: "fallback_default"; reason: string }
> {
  if (params.disabled) {
    return { kind: "skipped", reason: "disabled" };
  }
  if (params.config?.enabled === false) {
    return { kind: "skipped", reason: "config_disabled" };
  }
  const { signals, currentThinkingDefault } = params.bundle;
  if (signals.length === 0) {
    return {
      kind: "decision",
      decision: { thinkingLevel: "off", confidence: 0.55, reason: "lightweight turn", signals },
    };
  }
  if (
    signals.includes("high_stakes") &&
    (signals.includes("debugging") || signals.includes("planning"))
  ) {
    return {
      kind: "decision",
      decision: {
        thinkingLevel: "high",
        confidence: 0.92,
        reason: "high-stakes analytical turn",
        signals,
      },
    };
  }
  if (signals.includes("debugging")) {
    return {
      kind: "decision",
      decision: {
        thinkingLevel: "medium",
        confidence: 0.84,
        reason: "debugging requires inspection",
        signals,
      },
    };
  }
  if (
    signals.includes("planning") ||
    (signals.includes("coding") && signals.includes("multi_step"))
  ) {
    return {
      kind: "decision",
      decision: {
        thinkingLevel: "medium",
        confidence: 0.76,
        reason: "multi-step implementation/planning turn",
        signals,
      },
    };
  }
  if (
    signals.includes("coding") ||
    signals.includes("tool_likely") ||
    signals.includes("attachments")
  ) {
    return {
      kind: "decision",
      decision: { thinkingLevel: "low", confidence: 0.7, reason: "tool-assisted task", signals },
    };
  }
  return {
    kind: "fallback_default",
    reason: `uncertain:${currentThinkingDefault}`,
  };
}

export async function resolveAdaptiveThinking(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  explicitOverride?: ThinkLevel;
  sessionOverride?: ThinkLevel;
  currentMessage: string;
  recentMessages?: string[];
  attachmentCount?: number;
  catalog?: Parameters<typeof resolveThinkingDefault>[0]["catalog"];
  config?: AdaptiveThinkingConfig;
  logger?: (line: string) => void;
}): Promise<AdaptiveThinkingResolution> {
  if (params.explicitOverride) {
    return { thinkingLevel: params.explicitOverride, source: "explicit_override" };
  }
  if (params.sessionOverride) {
    return { thinkingLevel: params.sessionOverride, source: "session_override" };
  }
  const thinkingDefault = resolveThinkingDefault({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
  });
  const bundle = buildAdaptiveThinkingContextBundle({
    currentMessage: params.currentMessage,
    recentMessages: params.recentMessages,
    attachmentCount: params.attachmentCount,
    currentThinkingDefault: thinkingDefault,
    recentMessagesLimit: params.config?.recentMessages,
  });
  const result = await evaluateAdaptiveThinking({
    config: params.config,
    bundle,
    disabled: false,
  });
  const threshold = Math.max(0, Math.min(1, params.config?.confidenceThreshold ?? 0.7));
  if (result.kind === "decision" && result.decision.confidence >= threshold) {
    params.logger?.(
      `[adaptive-thinking] source=adaptive level=${result.decision.thinkingLevel} confidence=${result.decision.confidence.toFixed(2)} reason=${result.decision.reason ?? ""}`,
    );
    return {
      thinkingLevel: result.decision.thinkingLevel,
      source: "adaptive",
      confidence: result.decision.confidence,
      reason: result.decision.reason,
      signals: result.decision.signals,
    };
  }
  params.logger?.(
    `[adaptive-thinking] source=thinking_default level=${thinkingDefault} reason=${result.kind === "decision" ? "low_confidence" : result.reason}`,
  );
  return { thinkingLevel: thinkingDefault, source: "thinking_default" };
}
