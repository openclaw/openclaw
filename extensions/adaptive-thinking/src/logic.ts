import { normalizeThinkLevel, type ThinkLevel } from "../../../src/auto-reply/thinking.js";

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

export type AdaptiveThinkingConfig = {
  enabled?: boolean;
  confidenceThreshold?: number;
  recentMessages?: number;
};

export type AdaptiveThinkingEvent = {
  prompt: string;
  currentThinkingDefault?: ThinkLevel;
  explicitThinkingLevel?: ThinkLevel;
  sessionThinkingLevel?: ThinkLevel;
  attachmentCount?: number;
  recentMessages?: string[];
};

const SIGNALS: AdaptiveThinkingSignal[] = [
  "attachments",
  "coding",
  "debugging",
  "high_stakes",
  "long_context",
  "multi_step",
  "planning",
  "tool_likely",
];

function dedupeSignals(signals: AdaptiveThinkingSignal[]): AdaptiveThinkingSignal[] {
  return [...new Set(signals)];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  return Math.max(0, Math.min(1, value));
}

export function parseAdaptiveThinkingConfig(value: unknown): AdaptiveThinkingConfig {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const record = raw as Record<string, unknown>;
  const threshold =
    typeof record.confidenceThreshold === "number"
      ? clampConfidence(record.confidenceThreshold)
      : undefined;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    confidenceThreshold: Number.isFinite(threshold) ? threshold : undefined,
    recentMessages:
      typeof record.recentMessages === "number" && Number.isInteger(record.recentMessages)
        ? Math.max(0, record.recentMessages)
        : undefined,
  };
}

export function buildAdaptiveThinkingSignals(params: {
  prompt: string;
  recentMessages?: string[];
  attachmentCount?: number;
}): AdaptiveThinkingSignal[] {
  const trimmed = params.prompt.trim();
  const recentMessages = (params.recentMessages ?? []).map((entry) => entry.trim()).filter(Boolean);
  const lower = [trimmed, ...recentMessages].join("\n").toLowerCase();
  const signals: AdaptiveThinkingSignal[] = [];

  if ((params.attachmentCount ?? 0) > 0) {
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

  return dedupeSignals(signals);
}

export function evaluateAdaptiveThinking(params: {
  config: AdaptiveThinkingConfig;
  prompt: string;
  recentMessages?: string[];
  attachmentCount?: number;
  currentThinkingDefault: ThinkLevel;
}): AdaptiveThinkingDecision | undefined {
  if (params.config.enabled === false) {
    return undefined;
  }

  const signals = buildAdaptiveThinkingSignals({
    prompt: params.prompt,
    recentMessages: params.recentMessages,
    attachmentCount: params.attachmentCount,
  });

  if (signals.length === 0) {
    return { thinkingLevel: "off", confidence: 0.55, reason: "lightweight turn", signals };
  }
  if (
    signals.includes("high_stakes") &&
    (signals.includes("debugging") || signals.includes("planning"))
  ) {
    return {
      thinkingLevel: "high",
      confidence: 0.92,
      reason: "high-stakes analytical turn",
      signals,
    };
  }
  if (signals.includes("debugging")) {
    return {
      thinkingLevel: "medium",
      confidence: 0.84,
      reason: "debugging requires inspection",
      signals,
    };
  }
  if (
    signals.includes("planning") ||
    (signals.includes("coding") && signals.includes("multi_step"))
  ) {
    return {
      thinkingLevel: "medium",
      confidence: 0.76,
      reason: "multi-step implementation/planning turn",
      signals,
    };
  }
  if (
    signals.includes("coding") ||
    signals.includes("tool_likely") ||
    signals.includes("attachments")
  ) {
    return { thinkingLevel: "low", confidence: 0.7, reason: "tool-assisted task", signals };
  }

  void params.currentThinkingDefault;
  return undefined;
}

export function resolveAdaptiveThinkingOverride(params: {
  config: AdaptiveThinkingConfig;
  event: AdaptiveThinkingEvent;
}): ThinkLevel | undefined {
  const explicit = normalizeThinkLevel(params.event.explicitThinkingLevel);
  if (explicit && explicit !== "adaptive") {
    return undefined;
  }
  const session = normalizeThinkLevel(params.event.sessionThinkingLevel);
  if (session && session !== "adaptive") {
    return undefined;
  }
  const currentThinkingDefault = normalizeThinkLevel(params.event.currentThinkingDefault) ?? "off";
  const recentMessages = (params.event.recentMessages ?? []).slice(
    -(params.config.recentMessages ?? 3),
  );
  const decision = evaluateAdaptiveThinking({
    config: params.config,
    prompt: params.event.prompt,
    recentMessages,
    attachmentCount: params.event.attachmentCount,
    currentThinkingDefault,
  });
  const threshold = params.config.confidenceThreshold ?? 0.7;
  if (!decision || decision.confidence < threshold) {
    return undefined;
  }
  return decision.thinkingLevel;
}

export function isAdaptiveThinkingSignal(value: string): value is AdaptiveThinkingSignal {
  return (SIGNALS as string[]).includes(value);
}
