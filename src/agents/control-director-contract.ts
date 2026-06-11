export const CONTROL_DIRECTOR_AGENT_IDS = ["main", "control-director"] as const;

export const CONTROL_DIRECTOR_PRIMARY_ALIAS = "openclaw-control-qwen36-27b";
export const CONTROL_DIRECTOR_PRIMARY_MODEL = "ollama/openclaw-control-qwen36-27b:latest";
export const CONTROL_DIRECTOR_UNDERLYING_OLLAMA_TAG = "qwen3.6:27b-q8_0";
export const CONTROL_DIRECTOR_FIRST_FALLBACK_MODEL = "ollama/openclaw-control-qwen25-32b:latest";
export const CONTROL_DIRECTOR_EFFECTIVE_CONTEXT_TOKENS = 64_000;

export type ControlDirectorFinalStatus = "complete" | "blocked" | "needs_user_input";
export type ControlDirectorThinkingEscalationLevel = "off" | "medium" | "high";

export type ControlDirectorThinkingEscalation = {
  level: ControlDirectorThinkingEscalationLevel;
  reason: string;
  trigger?: string;
  escalated: boolean;
};

export type ControlDirectorResponseRequirements = {
  completionState?: boolean;
  verifiedEvidence?: boolean;
  completionGrade?: boolean;
  criticality?: boolean;
  nextBuildGap?: boolean;
};

export type ControlDirectorResponseEvaluation = {
  passed: boolean;
  status: ControlDirectorFinalStatus | null;
  missing: string[];
};

export type ControlDirectorReadinessFact = {
  id: string;
  label: string;
  passed: boolean;
  critical: boolean;
  detail?: string;
};

export type ControlDirectorReadinessScorecard = {
  completionGrade: number;
  criticality: number;
  productionReady: boolean;
  facts: ControlDirectorReadinessFact[];
  failedCritical: string[];
  nextBuildGap: string;
};

const STATUS_PATTERN = /\bstatus\s*:\s*(complete|blocked|needs[_ -]user[_ -]input)\b/i;
const FINISHED_PATTERN = /\b(finished|complete|completed|done)\b/i;
const BLOCKED_PATTERN = /\bblocked\b/i;
const NEEDS_INPUT_PATTERN = /\b(needs? user input|needs? input|needs? clarification)\b/i;
const EVIDENCE_PATTERN =
  /\b(verified|validation|evidence|proof|commands? run|tests? passed|smoke(?:-test)? evidence)\b/i;
const COMPLETION_GRADE_PATTERN = /\bcompletion grade\s*:\s*(?:10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i;
const CRITICALITY_PATTERN = /\bcriticality\s*:\s*(?:10|[0-9](?:\.\d+)?)\s*\/\s*10\b/i;
const NEXT_BUILD_GAP_PATTERN = /\bnext (?:most impactful )?build gap\b/i;

type ControlDirectorThinkingTrigger = {
  level: Exclude<ControlDirectorThinkingEscalationLevel, "off">;
  reason: string;
  pattern: RegExp;
};

const CONTROL_DIRECTOR_THINKING_TRIGGERS: ControlDirectorThinkingTrigger[] = [
  {
    level: "high",
    reason: "high-risk failure, rollback, runtime, or production-control task",
    pattern:
      /\b(?:failed?|failing|failure|error|regression|broken|crash|panic|timeout|blocked|stuck|conflicting evidence|contradict(?:ion|ory)|rollback|revert|hotfix|incident|production|prod|service|runtime|ollama|launchctl|launchd|restart|smoke[- ]?test|model\s+(?:routing|alias|selection|fallback|chain|promotion|switch|change)|qwen|context\s+window)\b/i,
  },
  {
    level: "medium",
    reason: "multi-step implementation, evaluation, validation, or build-gap task",
    pattern:
      /\b(?:implement|implementation|fix|debug|diagnose|test|verify|validation|validate|evaluate|evaluation|assess|audit|inspect|build\s+gap|completion\s+grade|criticality|plan|milestone|root\s+cause|triage|production[- ]grade|full\s+functionality|do\s+not\s+stop|continue\s+to\s+work|until\s+(?:complete|completed|done))\b/i,
  },
];

export function isControlDirectorAgentId(agentId: string | undefined | null): boolean {
  if (!agentId) {
    return false;
  }
  const normalized = agentId.trim().toLowerCase();
  return CONTROL_DIRECTOR_AGENT_IDS.some((candidate) => candidate === normalized);
}

export function buildControlDirectorSystemPromptSection(
  agentId: string | undefined | null,
): string[] {
  if (!isControlDirectorAgentId(agentId)) {
    return [];
  }
  return [
    "## Control Director Operating Contract",
    "You are the Control Director for this OpenClaw deployment. Treat the latest user request as the active mission.",
    "Do not stop at advice or a proposed next step when you can safely continue executing the user's requested work.",
    "Continue until the requested task is complete, a real blocker is proven, or user input is genuinely required.",
    "Before saying a task is finished, verify the requested outcome with concrete evidence such as source inspection, config proof, runtime status, tests, smoke output, or command results when feasible.",
    "If work is incomplete, do not call it complete. State the exact blocker or the next build gap and the smallest action that would close it.",
    "When the user asks for Completion Grade, Criticality, verified state, or next build gap, include those fields in every response until the user changes that reporting requirement.",
    "When reporting Completion Grade or Criticality, use numeric `/10` values unless the user explicitly asks for another scale.",
    "If the user gives an exact response format, follow that format exactly. Do not ask what task the format applies to when the current prompt itself defines a smoke, verification, or implementation task.",
    "Thinking policy: default to non-thinking for routine turns, but use thinking only as needed for implementation, evaluation, debugging, verification, rollback, model, runtime, service, or production-risk work.",
    "End task reports with an explicit status line using one of: `Status: complete`, `Status: blocked`, or `Status: needs_user_input`.",
    "",
  ];
}

export function resolveControlDirectorThinkingEscalation(params: {
  agentId: string | undefined | null;
  text?: string | undefined | null;
}): ControlDirectorThinkingEscalation | undefined {
  if (!isControlDirectorAgentId(params.agentId)) {
    return undefined;
  }
  const text = params.text?.trim() ?? "";
  if (!text) {
    return {
      level: "off",
      reason: "empty or low-risk Control Director turn",
      escalated: false,
    };
  }
  for (const trigger of CONTROL_DIRECTOR_THINKING_TRIGGERS) {
    const match = trigger.pattern.exec(text);
    if (match) {
      return {
        level: trigger.level,
        reason: trigger.reason,
        trigger: match[0],
        escalated: true,
      };
    }
  }
  return {
    level: "off",
    reason: "low-risk Control Director turn",
    escalated: false,
  };
}

export function parseControlDirectorFinalStatus(text: string): ControlDirectorFinalStatus | null {
  const explicit = STATUS_PATTERN.exec(text)?.[1]?.toLowerCase().replace(/[ -]/g, "_");
  if (explicit === "complete" || explicit === "blocked" || explicit === "needs_user_input") {
    return explicit;
  }
  if (BLOCKED_PATTERN.test(text)) {
    return "blocked";
  }
  if (NEEDS_INPUT_PATTERN.test(text)) {
    return "needs_user_input";
  }
  if (FINISHED_PATTERN.test(text)) {
    return "complete";
  }
  return null;
}

export function evaluateControlDirectorResponse(params: {
  text: string;
  requirements?: ControlDirectorResponseRequirements;
}): ControlDirectorResponseEvaluation {
  const requirements = params.requirements ?? {};
  const status = parseControlDirectorFinalStatus(params.text);
  const missing: string[] = [];
  if (requirements.completionState !== false && !status) {
    missing.push("explicit completion status");
  }
  if (requirements.verifiedEvidence && !EVIDENCE_PATTERN.test(params.text)) {
    missing.push("verified evidence");
  }
  if (requirements.completionGrade && !COMPLETION_GRADE_PATTERN.test(params.text)) {
    missing.push("Completion Grade /10");
  }
  if (requirements.criticality && !CRITICALITY_PATTERN.test(params.text)) {
    missing.push("Criticality /10");
  }
  if (requirements.nextBuildGap && !NEXT_BUILD_GAP_PATTERN.test(params.text)) {
    missing.push("next build gap");
  }
  return {
    passed: missing.length === 0,
    status,
    missing,
  };
}

export function scoreControlDirectorReadiness(
  facts: ControlDirectorReadinessFact[],
): ControlDirectorReadinessScorecard {
  const critical = facts.filter((fact) => fact.critical);
  const failedCritical = critical.filter((fact) => !fact.passed).map((fact) => fact.label);
  const passedCritical = critical.length - failedCritical.length;
  const passed = facts.filter((fact) => fact.passed).length;
  const criticalRatio = critical.length > 0 ? passedCritical / critical.length : 1;
  const overallRatio = facts.length > 0 ? passed / facts.length : 0;
  const completionGrade = Math.round((criticalRatio * 0.75 + overallRatio * 0.25) * 100) / 10;
  const nextFailed =
    facts.find((fact) => !fact.passed && fact.critical) ?? facts.find((fact) => !fact.passed);
  return {
    completionGrade,
    criticality: 10,
    productionReady: completionGrade >= 9.5 && failedCritical.length === 0,
    facts,
    failedCritical,
    nextBuildGap: nextFailed
      ? `${nextFailed.label}${nextFailed.detail ? `: ${nextFailed.detail}` : ""}`
      : "No critical Control Director build gap detected by this scorecard.",
  };
}

export const CONTROL_DIRECTOR_DETERMINISTIC_EVALS = [
  {
    id: "verified-complete-report",
    requirement: {
      completionState: true,
      verifiedEvidence: true,
      completionGrade: true,
      criticality: true,
      nextBuildGap: true,
    },
  },
  {
    id: "blocked-not-complete",
    requirement: {
      completionState: true,
      verifiedEvidence: false,
      completionGrade: true,
      criticality: true,
      nextBuildGap: true,
    },
  },
] as const;
