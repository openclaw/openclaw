import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { BuildRunArtifactName } from "./build-runs.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";

export const SUBAGENT_SESSION_ROLES = ["main", "orchestrator", "leaf"] as const;
export type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];

export const SUBAGENT_CONTROL_SCOPES = ["children", "none"] as const;
export type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

export const SUBAGENT_ROLE_PRESETS = ["planner", "builder", "evaluator"] as const;
export type SubagentRolePreset = (typeof SUBAGENT_ROLE_PRESETS)[number];

export type SubagentRolePresetDefaults = {
  promptMode: "plan" | "build" | "evaluate";
  toolBias: "read-heavy" | "edit-exec" | "inspect-verify";
  verificationPosture: "acceptance-first" | "self-check-before-handoff" | "skeptical-review";
  artifactWriteScope: "planner-artifacts" | "builder-artifacts" | "evaluator-artifacts";
};

export type SubagentRolePresetRuntimeDefaults = {
  systemPromptMode: "minimal" | "full";
  toolAllowlist: string[];
  artifactReadRefs: BuildRunArtifactName[];
  artifactWriteRefs: BuildRunArtifactName[];
};

type SessionCapabilityEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
  subagentRolePreset?: unknown;
};

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

export function normalizeSubagentRolePreset(value: unknown): SubagentRolePreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  return SUBAGENT_ROLE_PRESETS.find((entry) => entry === trimmed);
}

export function resolveSubagentRolePresetDefaults(
  preset: SubagentRolePreset | undefined,
): SubagentRolePresetDefaults | undefined {
  switch (preset) {
    case "planner":
      return {
        promptMode: "plan",
        toolBias: "read-heavy",
        verificationPosture: "acceptance-first",
        artifactWriteScope: "planner-artifacts",
      };
    case "builder":
      return {
        promptMode: "build",
        toolBias: "edit-exec",
        verificationPosture: "self-check-before-handoff",
        artifactWriteScope: "builder-artifacts",
      };
    case "evaluator":
      return {
        promptMode: "evaluate",
        toolBias: "inspect-verify",
        verificationPosture: "skeptical-review",
        artifactWriteScope: "evaluator-artifacts",
      };
    default:
      return undefined;
  }
}

export function resolveSubagentRolePresetRuntimeDefaults(params: {
  preset: SubagentRolePreset | undefined;
  canSpawn?: boolean;
}): SubagentRolePresetRuntimeDefaults | undefined {
  const canSpawn = params.canSpawn === true;
  const delegationTools = canSpawn
    ? ["sessions_spawn", "subagents", "sessions_list", "sessions_history"]
    : [];
  switch (params.preset) {
    case "planner":
      return {
        systemPromptMode: "minimal",
        toolAllowlist: [
          "read",
          "browser",
          "web_search",
          "web_fetch",
          "image",
          "pdf",
          ...delegationTools,
        ],
        artifactReadRefs: [],
        artifactWriteRefs: ["acceptance", "verify-pack"],
      };
    case "builder":
      return {
        systemPromptMode: "full",
        toolAllowlist: [
          "read",
          "edit",
          "write",
          "apply_patch",
          "exec",
          "process",
          ...delegationTools,
        ],
        artifactReadRefs: ["acceptance", "verify-pack"],
        artifactWriteRefs: ["build-report"],
      };
    case "evaluator":
      return {
        systemPromptMode: "minimal",
        toolAllowlist: [
          "read",
          "exec",
          "process",
          "browser",
          "web_search",
          "web_fetch",
          "image",
          "pdf",
          ...delegationTools,
        ],
        artifactReadRefs: ["acceptance", "verify-pack", "build-report"],
        artifactWriteRefs: ["eval-report"],
      };
    default:
      return undefined;
  }
}

function readSessionStore(storePath: string): Record<string, SessionCapabilityEntry> {
  try {
    return loadSessionStore(storePath);
  } catch {
    return {};
  }
}

function findEntryBySessionId(
  store: Record<string, SessionCapabilityEntry>,
  sessionId: string,
): SessionCapabilityEntry | undefined {
  const normalizedSessionId = normalizeSessionKey(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeSessionKey(entry?.sessionId);
    if (candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveSessionCapabilityEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: Record<string, SessionCapabilityEntry>;
}): SessionCapabilityEntry | undefined {
  if (params.store) {
    return params.store[params.sessionKey] ?? findEntryBySessionId(params.store, params.sessionKey);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
  const store = readSessionStore(storePath);
  return store[params.sessionKey] ?? findEntryBySessionId(store, params.sessionKey);
}

export function resolveSubagentRoleForDepth(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentSessionRole {
  const depth = Number.isInteger(params.depth) ? Math.max(0, params.depth) : 0;
  const maxSpawnDepth =
    typeof params.maxSpawnDepth === "number" && Number.isFinite(params.maxSpawnDepth)
      ? Math.max(1, Math.floor(params.maxSpawnDepth))
      : DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (depth <= 0) {
    return "main";
  }
  return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}

export function resolveSubagentControlScopeForRole(
  role: SubagentSessionRole,
): SubagentControlScope {
  return role === "leaf" ? "none" : "children";
}

export function resolveSubagentCapabilities(params: { depth: number; maxSpawnDepth?: number }) {
  const role = resolveSubagentRoleForDepth(params);
  const controlScope = resolveSubagentControlScopeForRole(role);
  return {
    depth: Math.max(0, Math.floor(params.depth)),
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
    rolePreset: undefined,
    rolePresetDefaults: undefined,
  };
}

export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionCapabilityEntry>;
  },
) {
  const normalizedSessionKey = normalizeSessionKey(sessionKey);
  const maxSpawnDepth =
    opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
    cfg: opts?.cfg,
    store: opts?.store,
  });
  if (!normalizedSessionKey || !isSubagentSessionKey(normalizedSessionKey)) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store: opts?.store,
  });
  const storedRole = normalizeSubagentRole(entry?.subagentRole);
  const storedControlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
  const storedRolePreset = normalizeSubagentRolePreset(entry?.subagentRolePreset);
  const fallback = resolveSubagentCapabilities({ depth, maxSpawnDepth });
  const role = storedRole ?? fallback.role;
  const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);
  return {
    depth,
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
    rolePreset: storedRolePreset,
    rolePresetDefaults: resolveSubagentRolePresetDefaults(storedRolePreset),
  };
}
