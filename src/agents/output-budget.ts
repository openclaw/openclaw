import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens } from "@mariozechner/pi-coding-agent";

/**
 * Output budget enforcement for OpenClaw roles.
 *
 * Roles map to session types:
 *   - dispatcher: main agent routing turn (default main session)
 *   - planner: planning subagent
 *   - executor: workhorse executor subagent
 *   - reasoner: heavy reasoning subagent
 *   - maintenance: maintenance / cron / heartbeat sessions
 *
 * Enforcement is two-layered:
 *   1. `max_tokens` on the API call (hard cap, provider-enforced)
 *   2. Post-response validator rejects outputs exceeding character budget (double safety)
 */

export type OutputRole = "dispatcher" | "planner" | "executor" | "reasoner" | "maintenance";

export const OUTPUT_BUDGET_DEFAULTS: Readonly<Record<OutputRole, number>> = {
  dispatcher: 800,
  planner: 2000,
  executor: 1200,
  reasoner: 1800,
  maintenance: 600,
};

/**
 * A budget violation carries enough context for callers to decide
 * whether to retry, summarise, or escalate.
 */
export type OutputBudgetViolation = {
  role: OutputRole;
  maxTokens: number;
  actualTokens: number;
  action: "summary_fallback";
};

/**
 * Resolved output budget for a given role (allows per-config overrides).
 */
export function resolveOutputBudget(params: {
  role: OutputRole;
  configOverrides?: Partial<Record<OutputRole, number>>;
}): number {
  const override = params.configOverrides?.[params.role];
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return OUTPUT_BUDGET_DEFAULTS[params.role];
}

/**
 * Estimate token count for an assistant output string.
 */
export function estimateOutputTokens(text: string): number {
  const msg: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
  };
  return estimateTokens(msg);
}

/**
 * Validate an assistant output against the budget for a given role.
 *
 * Returns `null` if within budget, or a violation descriptor otherwise.
 */
export function validateOutputBudget(params: {
  role: OutputRole;
  output: string;
  configOverrides?: Partial<Record<OutputRole, number>>;
}): OutputBudgetViolation | null {
  const maxTokens = resolveOutputBudget({
    role: params.role,
    configOverrides: params.configOverrides,
  });
  const actualTokens = estimateOutputTokens(params.output);

  if (actualTokens <= maxTokens) {
    return null;
  }

  return {
    role: params.role,
    maxTokens,
    actualTokens,
    action: "summary_fallback",
  };
}

/**
 * Infer the output role from a session key.
 *
 * Session key patterns:
 *   - "agent:main:main" or similar main sessions → dispatcher
 *   - "agent:main:subagent:..." → executor (default for subagents)
 *   - subagent label containing "plan" → planner
 *   - subagent label containing "reason" → reasoner
 *   - "cron:..." or "heartbeat:..." → maintenance
 *
 * Returns undefined if the role cannot be determined (no budget enforced).
 */
export function inferOutputRole(params: {
  sessionKey?: string;
  subagentLabel?: string;
}): OutputRole | undefined {
  const sessionKey = params.sessionKey?.trim();
  const label = params.subagentLabel?.trim().toLowerCase();

  // Maintenance sessions
  if (sessionKey?.startsWith("cron:") || sessionKey?.startsWith("heartbeat:")) {
    return "maintenance";
  }

  // Subagent sessions: check label for role hints
  if (sessionKey?.includes(":subagent:")) {
    if (label) {
      if (label.includes("plan")) return "planner";
      if (label.includes("reason") || label.includes("analys") || label.includes("think")) {
        return "reasoner";
      }
    }
    return "executor";
  }

  // Main sessions → dispatcher
  if (sessionKey) {
    return "dispatcher";
  }

  return undefined;
}

/**
 * Build a summary + artifact references fallback when output exceeds budget.
 *
 * This is the mandated fallback: never truncate silently.
 * Instead, store the full output as an artifact and return a short summary + reference.
 */
export function buildSummaryFallback(params: {
  role: OutputRole;
  output: string;
  violation: OutputBudgetViolation;
  artifactId?: string;
}): string {
  const maxChars = Math.max(200, params.violation.maxTokens); // rough chars ≈ tokens for summary
  const truncatedSummary =
    params.output.length > maxChars
      ? params.output.slice(0, maxChars).trimEnd() + "…"
      : params.output;

  const lines = [
    `[Output budget exceeded: ${params.violation.actualTokens} tokens > ${params.violation.maxTokens} max for role "${params.role}"]`,
    "",
    "Summary:",
    truncatedSummary,
  ];

  if (params.artifactId) {
    lines.push("", `Full output stored as artifact: ${params.artifactId}`);
    lines.push(`Use artifacts.get("${params.artifactId}") to retrieve the complete content.`);
  }

  return lines.join("\n");
}
