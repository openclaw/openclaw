import { normalizeToolName } from "./tool-policy.js";

type ActiveTurn = {
  skillName: string;
  delegatePlanSatisfied: boolean;
  updatedAt: number;
};

const ACTIVE_SKILL_TURNS = new Map<string, ActiveTurn>();
const STALE_TTL_MS = 10 * 60 * 1000;

function normalizeDelegationSkillName(skillName?: string): string | undefined {
  const normalized = skillName?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  // Keep a single canonical delegation model even if legacy aliases appear.
  if (normalized === "task-delegation" || normalized === "task_delegation") {
    return "delegate";
  }
  return normalized;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanupStaleTurns(now: number) {
  for (const [sessionKey, state] of ACTIVE_SKILL_TURNS) {
    if (now - state.updatedAt > STALE_TTL_MS) {
      ACTIVE_SKILL_TURNS.delete(sessionKey);
    }
  }
}

function buildSessionKeyCandidates(sessionKey?: string, agentId?: string): string[] {
  const raw = sessionKey?.trim();
  if (!raw) {
    return [];
  }
  const out = new Set<string>([raw]);
  const normalizedAgentId = agentId?.trim().toLowerCase();

  // Map short key -> canonical agent session key.
  if (normalizedAgentId && !raw.includes(":")) {
    out.add(`agent:${normalizedAgentId}:${raw}`);
  }

  // Map canonical agent session key -> short key fallback.
  const parts = raw.split(":");
  if (parts.length >= 3 && parts[0]?.toLowerCase() === "agent" && parts[2]) {
    out.add(parts[2]);
  }

  return Array.from(out);
}

function isDelegateRunCall(toolName: string, params: unknown): boolean {
  const normalizedName = normalizeToolName(toolName);
  if (normalizedName !== "workflows.run_workflow" && normalizedName !== "run_workflow") {
    return false;
  }
  if (!isPlainObject(params)) {
    return false;
  }
  return typeof params.name === "string" && params.name.trim().toLowerCase() === "delegate_run";
}

function isMissionSpawnTool(toolName: string): boolean {
  const normalizedName = normalizeToolName(toolName);
  return (
    normalizedName === "sessions_mission" ||
    normalizedName === "spawn_sequential_mission" ||
    normalizedName === "spawn_parallel_mission"
  );
}

export function setActiveSkillTurn(params: {
  sessionKey?: string;
  agentId?: string;
  skillName?: string;
}) {
  const candidates = buildSessionKeyCandidates(params.sessionKey, params.agentId);
  const skillName = normalizeDelegationSkillName(params.skillName);
  if (candidates.length === 0) {
    return;
  }
  const now = Date.now();
  cleanupStaleTurns(now);
  if (!skillName) {
    for (const key of candidates) {
      ACTIVE_SKILL_TURNS.delete(key);
    }
    return;
  }
  for (const key of candidates) {
    ACTIVE_SKILL_TURNS.set(key, {
      skillName,
      delegatePlanSatisfied: false,
      updatedAt: now,
    });
  }
}

export function detectSkillNameFromBody(body?: string): string | undefined {
  const trimmed = body?.trim();
  if (!trimmed) {
    return undefined;
  }

  // Slash command form: /delegate ...
  const slash = trimmed.match(/^\/([a-z0-9_-]+)\b/i);
  if (slash?.[1]) {
    return normalizeDelegationSkillName(slash[1]);
  }

  // Rewritten skill-invocation form used by inline action layer.
  const rewritten = trimmed.match(/^use the ["']([^"']+)["'] skill for this request\./i);
  if (rewritten?.[1]) {
    return normalizeDelegationSkillName(rewritten[1]);
  }

  return undefined;
}

export function clearActiveSkillTurn(sessionKey?: string) {
  const key = sessionKey?.trim();
  if (!key) {
    return;
  }
  ACTIVE_SKILL_TURNS.delete(key);
}

export function evaluateSkillTurnToolCall(params: {
  sessionKey?: string;
  agentId?: string;
  toolName: string;
  toolParams: unknown;
}): string | null {
  const candidates = buildSessionKeyCandidates(params.sessionKey, params.agentId);
  if (candidates.length === 0) {
    return null;
  }
  const now = Date.now();
  cleanupStaleTurns(now);
  let turn: ActiveTurn | undefined;
  for (const key of candidates) {
    const candidate = ACTIVE_SKILL_TURNS.get(key);
    if (candidate) {
      turn = candidate;
      break;
    }
  }
  if (!turn) {
    return null;
  }

  turn.updatedAt = now;
  if (turn.skillName !== "delegate") {
    return null;
  }

  if (isDelegateRunCall(params.toolName, params.toolParams)) {
    turn.delegatePlanSatisfied = true;
    for (const key of candidates) {
      ACTIVE_SKILL_TURNS.set(key, turn);
    }
    return null;
  }

  if (isMissionSpawnTool(params.toolName) && !turn.delegatePlanSatisfied) {
    return "Delegate guard: call workflows.run_workflow(name=delegate_run) before spawning mission tools.";
  }

  return null;
}

export const __testing = {
  ACTIVE_SKILL_TURNS,
  buildSessionKeyCandidates,
  detectSkillNameFromBody,
  isDelegateRunCall,
  isMissionSpawnTool,
};
