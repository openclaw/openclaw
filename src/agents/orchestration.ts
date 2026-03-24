import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type OrchestrationTaskType =
  | "analysis"
  | "draft"
  | "critique"
  | "plan"
  | "estimate"
  | "review";

export type OrchestrationPriority = "low" | "normal" | "high";

export type OrchestrationReturnFormat =
  | "bullets"
  | "draft"
  | "json-like structured text"
  | "decision memo";

export type OrchestrationArtifact = {
  id?: string;
  path?: string;
  url?: string;
  env?: string;
  fileName?: string;
  errorSnippet?: string;
  note?: string;
};

export type OrchestrationHandoffEnvelope = {
  targetAgent: string;
  objective: string;
  taskType: OrchestrationTaskType;
  requestedOutput: string;
  constraints: string[];
  knownFacts: string[];
  relevantArtifacts: OrchestrationArtifact[];
  priority: OrchestrationPriority;
  returnFormat: OrchestrationReturnFormat;
};

export type OrchestrationResponseStatus = "success" | "partial" | "blocked";

export type OrchestrationResponseEnvelope = {
  agentId: string;
  status: OrchestrationResponseStatus;
  summary: string;
  keyFindings: string[];
  assumptions: string[];
  risks: string[];
  output: string;
  followUpNeeded: string[];
  suggestedNextAgent?: string;
};

export type OrchestrationCommunicationPolicy = {
  allowDirectSpecialistToSpecialist?: boolean;
  requireStructuredHandoff?: boolean;
  requireStructuredReturn?: boolean;
  allowParallelDelegation?: boolean;
};

export type OrchestrationLimits = {
  maxDelegationDepth?: number;
  maxAgentsPerRequest?: number;
  dedupeRepeatedHandoffs?: boolean;
  stopWhenNoNewInformation?: boolean;
};

export type OrchestrationEnvelopePolicy = {
  enabled?: boolean;
};

export type ResolvedOrchestrationConfig = {
  communication: Required<OrchestrationCommunicationPolicy>;
  limits: Required<OrchestrationLimits>;
  handoffEnvelope: Required<OrchestrationEnvelopePolicy>;
  responseEnvelope: Required<OrchestrationEnvelopePolicy>;
};

const DEFAULT_ORCHESTRATION_CONFIG: ResolvedOrchestrationConfig = {
  communication: {
    allowDirectSpecialistToSpecialist: false,
    requireStructuredHandoff: true,
    requireStructuredReturn: true,
    allowParallelDelegation: true,
  },
  limits: {
    maxDelegationDepth: 2,
    maxAgentsPerRequest: 3,
    dedupeRepeatedHandoffs: true,
    stopWhenNoNewInformation: true,
  },
  handoffEnvelope: {
    enabled: true,
  },
  responseEnvelope: {
    enabled: true,
  },
};

export function resolveOrchestrationConfig(cfg: OpenClawConfig): ResolvedOrchestrationConfig {
  const raw = cfg.agents?.orchestration;
  return {
    communication: {
      ...DEFAULT_ORCHESTRATION_CONFIG.communication,
      ...raw?.communication,
    },
    limits: {
      ...DEFAULT_ORCHESTRATION_CONFIG.limits,
      ...raw?.limits,
    },
    handoffEnvelope: {
      ...DEFAULT_ORCHESTRATION_CONFIG.handoffEnvelope,
      ...raw?.handoffEnvelope,
    },
    responseEnvelope: {
      ...DEFAULT_ORCHESTRATION_CONFIG.responseEnvelope,
      ...raw?.responseEnvelope,
    },
  };
}

export function formatMainDispatchGuide(cfg: OpenClawConfig): string {
  const orchestration = resolveOrchestrationConfig(cfg);
  const sequentialLine = orchestration.communication.allowParallelDelegation
    ? "- Use multi-agent sequential delegation when specialist outputs depend on each other or must build on prior findings."
    : "- Prefer sequential delegation only; parallel delegation is disabled by policy.";
  const parallelLine = orchestration.communication.allowParallelDelegation
    ? `- Use multi-agent parallel-safe delegation only for independent workstreams, and keep total agents per request at or below ${orchestration.limits.maxAgentsPerRequest}.`
    : "- Do not use parallel delegation.";
  return [
    "You are the only dispatcher and synthesizer for the user-visible chat.",
    "",
    "Dispatch Playbook",
    "1. Classify request",
    "- Identify the user's intent, the domains involved, and whether the request is simple enough to answer directly.",
    "- Decide between: direct answer, one-agent delegation, multi-agent sequential delegation, or multi-agent parallel-safe delegation.",
    "",
    "2. Choose execution mode",
    "- Answer directly when the request is simple, low-risk, or does not require specialist depth.",
    "- Use one-agent delegation when exactly one specialist domain is needed.",
    sequentialLine,
    parallelLine,
    "- Do not delegate everything by default; delegation must reduce risk or improve specialist quality.",
    "",
    "3. Build handoff",
    "- Send only a short structured handoff packet.",
    "- Include only objective, requested output, constraints, known facts, and relevant artifacts.",
    "- Never forward the entire chat transcript unless it is strictly necessary.",
    "",
    "4. Evaluate specialist returns",
    "- Read specialist status carefully: success, partial, or blocked.",
    "- Incorporate keyFindings, assumptions, risks, and followUpNeeded.",
    "- Do not repeat delegation if no materially new information was added.",
    `- Respect safeguards: max delegation depth ${orchestration.limits.maxDelegationDepth}, max agents per request ${orchestration.limits.maxAgentsPerRequest}, repeated handoff dedupe ${orchestration.limits.dedupeRepeatedHandoffs ? "enabled" : "disabled"}, stop when no new information ${orchestration.limits.stopWhenNoNewInformation ? "enabled" : "disabled"}.`,
    "",
    "5. Synthesize final answer",
    "- Return one clean final answer to the user.",
    "- Never expose raw agent-to-agent envelopes or inter-agent chatter.",
    "- Deduplicate overlapping findings and keep only the conclusions that matter.",
    "- If specialist work is partial or blocked, explain the limitation briefly and ask only for the next missing step if needed.",
  ].join("\n");
}

export function formatMainSynthesisStyleGuide(): string {
  return [
    "Synthesis Style Guide",
    "- Return only the final user-facing answer; never expose raw specialist envelopes, field names, or orchestration internals.",
    "- Remove inter-agent noise, technical coordination chatter, and duplicated reasoning before replying.",
    "- Deduplicate overlapping findings and do not repeat the same point in different words.",
    "- Keep the answer compact but sufficient: clean, calm, competent, and business-ready.",
    "- Avoid long introductions, self-reference, filler, and lines like 'if you want, I can...'.",
    "- Choose one dominant final-answer form unless the user explicitly asked for something else:",
    "  - direct answer",
    "  - recommendation",
    "  - action plan",
    "  - draft",
    "  - decision memo",
    "  - blocked/needs input",
    "- If the request is a draft, lead with the draft itself.",
    "- If the request is an analysis, lead with the conclusion and then the key points.",
    "- If the request is an action plan, use ordered steps.",
    "- If the request is a decision request, give the recommendation first and a brief why.",
    "- Use specialist summary and keyFindings to build the final answer.",
    "- Mention risks only when they materially affect the decision or execution.",
    "- Mention assumptions only when they materially change the answer.",
    "- Use followUpNeeded only as the next required user input or next operational step.",
    "- Never surface suggestedNextAgent to the user as internal routing mechanics.",
    "- If work is partial or blocked, explain the limitation briefly and ask only one precise next question when needed.",
  ].join("\n");
}

export function formatSpecialistDisciplineGuide(): string {
  return [
    "Specialist Discipline",
    "- Stay strictly inside your assigned domain and the exact task you were given.",
    "- Do not broaden scope, add optional extras, or suggest adjacent work unless explicitly requested.",
    "- Do not append lines like 'if you want, I can...' or offer unsolicited variants.",
    "- Do not ask clarifying questions if the task is executable with the provided information.",
    "- If critical information is missing, return status: partial and ask one short, necessary question only.",
    "- Keep responses brief, concrete, and free of marketing or conversational filler.",
    "- Main is the only user-facing synthesizer; you are not the conversational layer.",
  ].join("\n");
}

export function composeAgentRolePrompt(params: {
  cfg: OpenClawConfig;
  agentId: string;
  baseRolePrompt?: string;
  mainAgentId?: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const mainAgentId = normalizeAgentId(params.mainAgentId ?? "main");
  const baseRolePrompt = params.baseRolePrompt?.trim();
  if (agentId !== mainAgentId) {
    const specialistGuide = formatSpecialistDisciplineGuide().trim();
    if (!baseRolePrompt) {
      return specialistGuide;
    }
    return [baseRolePrompt, "", specialistGuide].join("\n\n");
  }
  const guide = [
    formatMainDispatchGuide(params.cfg).trim(),
    formatMainSynthesisStyleGuide().trim(),
  ].join("\n\n");
  if (!baseRolePrompt) {
    return guide;
  }
  return [baseRolePrompt, "", guide].join("\n\n");
}

function normalizeLineArray(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function normalizeArtifacts(values: OrchestrationArtifact[] | undefined): OrchestrationArtifact[] {
  return (values ?? [])
    .map((entry) => ({
      id: entry.id?.trim() || undefined,
      path: entry.path?.trim() || undefined,
      url: entry.url?.trim() || undefined,
      env: entry.env?.trim() || undefined,
      fileName: entry.fileName?.trim() || undefined,
      errorSnippet: entry.errorSnippet?.trim() || undefined,
      note: entry.note?.trim() || undefined,
    }))
    .filter((entry) => Object.values(entry).some(Boolean));
}

export function buildHandoffEnvelope(params: {
  targetAgent: string;
  objective?: string;
  taskText: string;
  taskType?: OrchestrationTaskType;
  requestedOutput?: string;
  constraints?: string[];
  knownFacts?: string[];
  relevantArtifacts?: OrchestrationArtifact[];
  priority?: OrchestrationPriority;
  returnFormat?: OrchestrationReturnFormat;
}): OrchestrationHandoffEnvelope {
  const taskText = params.taskText.trim();
  return {
    targetAgent: params.targetAgent.trim(),
    objective: params.objective?.trim() || taskText,
    taskType: params.taskType ?? "analysis",
    requestedOutput:
      params.requestedOutput?.trim() || "Return only the specialist result needed by Main.",
    constraints: normalizeLineArray(params.constraints),
    knownFacts: normalizeLineArray(params.knownFacts),
    relevantArtifacts: normalizeArtifacts(params.relevantArtifacts),
    priority: params.priority ?? "normal",
    returnFormat: params.returnFormat ?? "bullets",
  };
}

export function formatHandoffEnvelope(envelope: OrchestrationHandoffEnvelope): string {
  const artifactLines = envelope.relevantArtifacts.length
    ? envelope.relevantArtifacts.map((artifact) => `- ${JSON.stringify(artifact)}`).join("\n")
    : "- none";
  const constraints = envelope.constraints.length
    ? envelope.constraints.map((value) => `- ${value}`).join("\n")
    : "- none";
  const knownFacts = envelope.knownFacts.length
    ? envelope.knownFacts.map((value) => `- ${value}`).join("\n")
    : "- none";
  return [
    "[Structured Handoff]",
    `targetAgent: ${envelope.targetAgent}`,
    `objective: ${envelope.objective}`,
    `taskType: ${envelope.taskType}`,
    `requestedOutput: ${envelope.requestedOutput}`,
    `priority: ${envelope.priority}`,
    `returnFormat: ${envelope.returnFormat}`,
    "constraints:",
    constraints,
    "knownFacts:",
    knownFacts,
    "relevantArtifacts:",
    artifactLines,
  ].join("\n");
}

export function formatTaskForSubagent(params: {
  envelope: OrchestrationHandoffEnvelope;
  rawTaskText: string;
  includeEnvelope: boolean;
}): string {
  if (!params.includeEnvelope) {
    return params.rawTaskText.trim();
  }
  return [
    formatHandoffEnvelope(params.envelope),
    "",
    "[Task for specialist]",
    params.rawTaskText.trim(),
  ].join("\n");
}

function parseListBlock(text: string, label: string): string[] {
  const regex = new RegExp(`^${label}:\\s*$([\\s\\S]*?)(?=^\\w[\\w ]*:\\s*$|\\Z)`, "im");
  const match = text.match(regex);
  if (!match) {
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseScalar(text: string, label: string): string | undefined {
  const regex = new RegExp(`^${label}:\\s*(.+)$`, "im");
  const match = text.match(regex);
  return match?.[1]?.trim() || undefined;
}

function parseMultilineScalar(text: string, label: string): string | undefined {
  const regex = new RegExp(`^${label}:\\s*$([\\s\\S]*?)(?=^\\w[\\w ]*:\\s*$|\\Z)`, "im");
  const match = text.match(regex);
  const value = match?.[1]?.trim();
  return value || undefined;
}

export function parseSpecialistResponseEnvelope(params: {
  text?: string;
  fallbackAgentId: string;
}): OrchestrationResponseEnvelope | null {
  const text = params.text?.trim();
  if (!text) {
    return null;
  }
  const status = parseScalar(text, "status");
  const summary = parseScalar(text, "summary") ?? parseMultilineScalar(text, "summary");
  const output = parseMultilineScalar(text, "output") ?? text;
  if (!status && !summary) {
    return null;
  }
  const normalizedStatus: OrchestrationResponseStatus =
    status === "partial" || status === "blocked" ? status : "success";
  return {
    agentId: parseScalar(text, "agentId") ?? params.fallbackAgentId,
    status: normalizedStatus,
    summary: summary ?? output.split(/\r?\n/, 1)[0] ?? "No summary provided.",
    keyFindings: parseListBlock(text, "keyFindings"),
    assumptions: parseListBlock(text, "assumptions"),
    risks: parseListBlock(text, "risks"),
    output,
    followUpNeeded: parseListBlock(text, "followUpNeeded"),
    suggestedNextAgent: parseScalar(text, "suggestedNextAgent"),
  };
}

export function formatSpecialistResponseForParent(envelope: OrchestrationResponseEnvelope): string {
  const listOrNone = (values: string[]) =>
    values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
  return [
    "[Structured Specialist Response]",
    `agentId: ${envelope.agentId}`,
    `status: ${envelope.status}`,
    `summary: ${envelope.summary}`,
    "keyFindings:",
    listOrNone(envelope.keyFindings),
    "assumptions:",
    listOrNone(envelope.assumptions),
    "risks:",
    listOrNone(envelope.risks),
    "output:",
    envelope.output.trim() || "(no output)",
    "followUpNeeded:",
    listOrNone(envelope.followUpNeeded),
    `suggestedNextAgent: ${envelope.suggestedNextAgent ?? "none"}`,
  ].join("\n");
}

export function buildHandoffFingerprint(envelope: OrchestrationHandoffEnvelope): string {
  return JSON.stringify({
    targetAgent: envelope.targetAgent,
    objective: envelope.objective,
    taskType: envelope.taskType,
    requestedOutput: envelope.requestedOutput,
    constraints: envelope.constraints,
    knownFacts: envelope.knownFacts,
    relevantArtifacts: envelope.relevantArtifacts,
    priority: envelope.priority,
    returnFormat: envelope.returnFormat,
  });
}
