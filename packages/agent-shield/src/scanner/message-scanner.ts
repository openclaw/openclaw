// Runs every rule against a content unit and aggregates the result.

import { RULES } from "../rules/index.js";
import type {
  ScanContext,
  ScanResult,
  ThreatMatch,
  ThreatAction,
  Severity,
  MessageSource,
  AgentShieldConfig,
} from "../types.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const ACTION_PRIORITY: Record<ThreatAction, number> = {
  log: 0,
  warn: 1,
  redact: 2,
  pause_agent: 3,
  escalate: 4,
  block: 5,
};

export function scan(
  content: string,
  source: MessageSource,
  config: AgentShieldConfig,
  delegationDepth: number = 0,
  delegationChain: string[] = [],
  priorMatches: ThreatMatch[] = [],
  toolName?: string
): ScanResult {
  const start = performance.now();

  if (!config.enabled) {
    return {
      clean: true,
      matches: [],
      durationMs: performance.now() - start,
      maxSeverity: null,
      action: "allow",
    };
  }

  const ctx: ScanContext = {
    content,
    source,
    delegationDepth,
    delegationChain,
    toolName,
    priorMatches,
  };

  const matches: ThreatMatch[] = [];

  // Configured depth check happens here so rules don't need to know about config.
  if (delegationDepth > config.maxDelegationDepth) {
    matches.push({
      ruleId: "CONFIG_DEPTH",
      ruleName: "Configured Delegation Depth Exceeded",
      category: "delegation_loop",
      severity: "high",
      confidence: 1.0,
      excerpt: `Depth ${delegationDepth} > max ${config.maxDelegationDepth}`,
      action: "block",
      explanation:
        `Delegation depth (${delegationDepth}) exceeds configured maximum ` +
        `(${config.maxDelegationDepth}). Blocking to prevent runaway delegation.`,
    });
  }

  for (const rule of RULES) {
    try {
      const result = rule.evaluate(ctx);
      if (result) {
        matches.push(result);
      }
    } catch (err) {
      // A bad rule must not take down the scanner.
      matches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        category: rule.category,
        severity: "info",
        confidence: 0,
        excerpt: "[rule evaluation error]",
        action: "log",
        explanation: `Rule ${rule.id} threw during evaluation: ${String(err)}`,
      });
    }
  }

  const maxSeverity = matches.length > 0
    ? matches.reduce<Severity>((max, m) =>
        SEVERITY_ORDER[m.severity] > SEVERITY_ORDER[max] ? m.severity : max,
      "info")
    : null;

  const maxAction: ThreatAction | "allow" = matches.length > 0
    ? matches.reduce<ThreatAction>((max, m) =>
        ACTION_PRIORITY[m.action] > ACTION_PRIORITY[max] ? m.action : max,
      "log")
    : "allow";

  // monitor mode never blocks
  const effectiveAction = config.mode === "monitor" ? "allow" : maxAction;

  return {
    clean: matches.length === 0,
    matches,
    durationMs: performance.now() - start,
    maxSeverity,
    action: effectiveAction,
  };
}

// Convenience wrapper for callers that only want a boolean.
export function isClean(
  content: string,
  source: MessageSource,
  config: AgentShieldConfig
): boolean {
  return scan(content, source, config).clean;
}
