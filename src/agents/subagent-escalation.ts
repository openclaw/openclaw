import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { normalizeModelSelection } from "./model-selection.js";

const log = createSubsystemLogger("subagent-escalation");

export type SubagentEscalationTier = "moderate" | "complex";
export type SubagentEscalationStage = "triage" | "worker";

type SubagentEscalationEnvelope = {
  tier: SubagentEscalationTier;
  reason: string;
  summary: string;
};

export type ParsedSubagentEscalationRequest = SubagentEscalationEnvelope;

export type SubagentEscalationHandoff = {
  version: 1;
  stage: "worker";
  tier: SubagentEscalationTier;
  taskTag: string;
  reason: string;
  originalTask: string;
  triageSummary: string;
};

export type ResolvedSubagentEscalationConfig = {
  enabled: boolean;
  moderateModel?: string;
  complexModel?: string;
};

const ESCALATION_REQUEST_BEGIN = "<<<BEGIN_OPENCLAW_TASK_ESCALATION_V1>>>";
const ESCALATION_REQUEST_END = "<<<END_OPENCLAW_TASK_ESCALATION_V1>>>";
const ESCALATION_HANDOFF_BEGIN = "<<<BEGIN_OPENCLAW_ESCALATION_HANDOFF_V1>>>";
const ESCALATION_HANDOFF_END = "<<<END_OPENCLAW_ESCALATION_HANDOFF_V1>>>";
const ESCALATION_REASON_RE = /^[a-z0-9_]{3,64}$/;

function extractStrictJsonEnvelope(
  text: string,
  markers: { begin: string; end: string },
): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(markers.begin) || !trimmed.endsWith(markers.end)) {
    return null;
  }
  const inner = trimmed.slice(markers.begin.length, trimmed.length - markers.end.length).trim();
  return inner || null;
}

function sanitizeSummary(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length <= 4000 ? trimmed : trimmed.slice(0, 4000).trim();
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return ESCALATION_REASON_RE.test(normalized) ? normalized : null;
}

export function resolveSubagentEscalationConfig(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): ResolvedSubagentEscalationConfig {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  const defaults = params.cfg.agents?.defaults?.subagents?.escalation;
  const overrides = agentConfig?.subagents?.escalation;
  return {
    enabled: overrides?.enabled ?? defaults?.enabled ?? false,
    moderateModel:
      normalizeModelSelection(overrides?.moderateModel) ??
      normalizeModelSelection(defaults?.moderateModel),
    complexModel:
      normalizeModelSelection(overrides?.complexModel) ??
      normalizeModelSelection(defaults?.complexModel),
  };
}

export function resolveSubagentEscalationTierModel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  tier: SubagentEscalationTier;
}): string | undefined {
  const resolved = resolveSubagentEscalationConfig(params);
  return params.tier === "moderate" ? resolved.moderateModel : resolved.complexModel;
}

export function resolveSubagentEscalationTaskTag(params: {
  label?: string | null;
  capability?: string | null;
  role?: string | null;
  agentId?: string | null;
}): string {
  const candidates = [params.label, params.capability, params.role, params.agentId];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return "unlabeled";
}

export function buildSubagentTriagePromptAddon(): string {
  return [
    "## Escalation Ladder",
    "You are the cheap triage tier for this spawned task.",
    "Either solve the task yourself or request escalation. Do NOT spawn subagents for escalation.",
    "If you can finish well at this tier, reply normally with the real result.",
    "If the task needs a stronger model, stop and reply with ONLY this strict envelope:",
    "",
    ESCALATION_REQUEST_BEGIN,
    '{"tier":"moderate|complex","reason":"short_snake_case_reason","summary":"brief handoff summary"}',
    ESCALATION_REQUEST_END,
    "",
    'Use "moderate" for medium-complex work and "complex" for the hardest work.',
    "Keep reason lowercase snake_case. Keep summary concise, factual, and plain text.",
    "Do not include any text before or after the envelope when escalating.",
  ].join("\n");
}

export function buildSubagentWorkerPromptAddon(): string {
  return [
    "## Escalation Handoff",
    "This task was escalated after triage.",
    "Execute it directly. Do NOT emit an escalation envelope.",
  ].join("\n");
}

export function parseSubagentEscalationRequest(
  text: string,
): ParsedSubagentEscalationRequest | null {
  const json = extractStrictJsonEnvelope(text, {
    begin: ESCALATION_REQUEST_BEGIN,
    end: ESCALATION_REQUEST_END,
  });
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as {
      tier?: unknown;
      reason?: unknown;
      summary?: unknown;
    };
    const tier = parsed.tier === "moderate" || parsed.tier === "complex" ? parsed.tier : undefined;
    const reason = sanitizeReason(parsed.reason);
    const summary = sanitizeSummary(parsed.summary);
    if (!tier || !reason || !summary) {
      return null;
    }
    return { tier, reason, summary };
  } catch {
    return null;
  }
}

export function buildSubagentEscalationHandoffPacket(handoff: SubagentEscalationHandoff): string {
  return [ESCALATION_HANDOFF_BEGIN, JSON.stringify(handoff, null, 2), ESCALATION_HANDOFF_END].join(
    "\n",
  );
}

export function parseSubagentEscalationHandoff(text: string): SubagentEscalationHandoff | null {
  const json = extractStrictJsonEnvelope(text, {
    begin: ESCALATION_HANDOFF_BEGIN,
    end: ESCALATION_HANDOFF_END,
  });
  if (!json) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as Partial<SubagentEscalationHandoff>;
    if (parsed.version !== 1 || parsed.stage !== "worker") {
      return null;
    }
    if (parsed.tier !== "moderate" && parsed.tier !== "complex") {
      return null;
    }
    const taskTag = sanitizeSummary(parsed.taskTag);
    const reason = sanitizeReason(parsed.reason);
    const originalTask = sanitizeSummary(parsed.originalTask);
    const triageSummary = sanitizeSummary(parsed.triageSummary);
    if (!taskTag || !reason || !originalTask || !triageSummary) {
      return null;
    }
    return {
      version: 1,
      stage: "worker",
      tier: parsed.tier,
      taskTag,
      reason,
      originalTask,
      triageSummary,
    };
  } catch {
    return null;
  }
}

export function buildSubagentEscalationWorkerTask(handoff: SubagentEscalationHandoff): string {
  return [
    "[Escalation Handoff]",
    `Tier: ${handoff.tier}`,
    `Task tag: ${handoff.taskTag}`,
    `Reason: ${handoff.reason}`,
    "",
    "Original task:",
    handoff.originalTask,
    "",
    "Triage summary:",
    handoff.triageSummary,
  ].join("\n");
}

export function logSubagentEscalationDecision(params: {
  stage: SubagentEscalationStage;
  ladderTier: "triage" | SubagentEscalationTier;
  taskTag: string;
  resolvedModel?: string;
  agentId: string;
  reason?: string;
}) {
  log.info("subagent escalation ladder decision", {
    agent: params.agentId,
    task_tag: params.taskTag,
    ladder_tier: params.ladderTier,
    stage: params.stage,
    resolved_model: params.resolvedModel,
    reason: params.reason,
  });
}
