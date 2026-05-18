import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";

export type SubagentSessionRole = "main" | "orchestrator" | "leaf";
const SUBAGENT_SESSION_ROLES: readonly SubagentSessionRole[] = [
  "main",
  "orchestrator",
  "leaf",
] as const;

type SubagentControlScope = "children" | "none";
const SUBAGENT_CONTROL_SCOPES: readonly SubagentControlScope[] = ["children", "none"] as const;

type SessionCapabilityEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
  spawnedBy?: unknown;
  inheritedToolAllow?: unknown;
  inheritedToolDeny?: unknown;
};

export type SessionCapabilityStore = Record<
  string,
  {
    sessionId?: unknown;
    spawnDepth?: unknown;
    subagentRole?: unknown;
    subagentControlScope?: unknown;
    spawnedBy?: unknown;
    inheritedToolAllow?: unknown;
    inheritedToolDeny?: unknown;
  }
>;

export const SUBAGENT_CAPABILITY_PREFLIGHT_PROFILE_MISMATCH =
  "BLOCKED_INFRA_PROFILE_MISMATCH" as const;

export type SubagentCapabilityPreflightProfile = "default" | "read-only" | "image-only";

export type SubagentCapabilityPreflightRequest = {
  requiredTools?: unknown;
  writablePaths?: unknown;
  readableRoots?: unknown;
  expectedRuntimeSeconds?: unknown;
  artifactOutputPath?: unknown;
  logOutputPath?: unknown;
  scratchPaths?: unknown;
  requiresShell?: unknown;
  profile?: unknown;
};

export type SubagentCapabilityPreflightResult =
  | {
      ok: true;
      normalized: {
        profile: SubagentCapabilityPreflightProfile;
        requiredTools: string[];
        writablePaths: string[];
        readableRoots: string[];
        artifactOutputPath?: string;
        logOutputPath?: string;
        scratchPaths: string[];
        expectedRuntimeSeconds?: number;
        requiresShell: boolean;
      };
    }
  | {
      ok: false;
      code: typeof SUBAGENT_CAPABILITY_PREFLIGHT_PROFILE_MISMATCH;
      message: string;
      reasons: string[];
      missingTools: string[];
      blockedPaths: string[];
    };

const SUBAGENT_PREFLIGHT_WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "fs_write"]);
const SUBAGENT_PREFLIGHT_SHELL_TOOLS = new Set(["exec", "process", "shell", "spawn"]);

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizePreflightProfile(value: unknown): SubagentCapabilityPreflightProfile {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "read-only" || normalized === "readonly" || normalized === "read_only") {
    return "read-only";
  }
  if (normalized === "image-only" || normalized === "imageonly" || normalized === "image_only") {
    return "image-only";
  }
  return "default";
}

function normalizePositiveDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.ceil(value);
}

function resolvePathForPreflight(value: string, workspaceDir?: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return path.resolve(workspaceDir || process.cwd(), trimmed);
}

function isPathEqualOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWritableCheckPath(pathValue: string, workspaceDir?: string): string {
  const resolved = resolvePathForPreflight(pathValue, workspaceDir);
  if (!resolved) {
    return "";
  }
  if (fs.existsSync(resolved)) {
    return resolved;
  }
  return path.dirname(resolved);
}

function isPathAccessible(pathValue: string, mode: number): boolean {
  try {
    fs.accessSync(pathValue, mode);
    return true;
  } catch {
    return false;
  }
}

function isToolAllowedByInheritedPolicy(
  toolName: string,
  inheritedAllowlist: string[],
  inheritedDenylist: string[],
): boolean {
  const allowPolicy = inheritedAllowlist.length > 0 ? { allow: inheritedAllowlist } : undefined;
  const denyPolicy = inheritedDenylist.length > 0 ? { deny: inheritedDenylist } : undefined;
  return (
    isToolAllowedByPolicyName(toolName, allowPolicy) &&
    isToolAllowedByPolicyName(toolName, denyPolicy)
  );
}

function makePreflightFailure(params: {
  reasons: string[];
  missingTools?: string[];
  blockedPaths?: string[];
}): SubagentCapabilityPreflightResult {
  const reasons = params.reasons.filter(Boolean);
  return {
    ok: false,
    code: SUBAGENT_CAPABILITY_PREFLIGHT_PROFILE_MISMATCH,
    message: `${SUBAGENT_CAPABILITY_PREFLIGHT_PROFILE_MISMATCH}: ${reasons.join("; ")}`,
    reasons,
    missingTools: [...new Set(params.missingTools ?? [])].toSorted(),
    blockedPaths: [...new Set(params.blockedPaths ?? [])].toSorted(),
  };
}

export function validateSubagentCapabilityPreflight(
  request: SubagentCapabilityPreflightRequest | undefined,
  runtime?: {
    inheritedToolAllowlist?: unknown;
    inheritedToolDenylist?: unknown;
    isToolAllowed?: (toolName: string) => boolean;
    workspaceDir?: string;
    runTimeoutSeconds?: number;
  },
): SubagentCapabilityPreflightResult {
  const profile = normalizePreflightProfile(request?.profile);
  const requiredTools = normalizeInheritedToolAllowlist(request?.requiredTools);
  const writablePaths = normalizeStringList(request?.writablePaths);
  const readableRoots = normalizeStringList(request?.readableRoots);
  const artifactOutputPath =
    typeof request?.artifactOutputPath === "string" && request.artifactOutputPath.trim()
      ? request.artifactOutputPath.trim()
      : undefined;
  const logOutputPath =
    typeof request?.logOutputPath === "string" && request.logOutputPath.trim()
      ? request.logOutputPath.trim()
      : undefined;
  const scratchPaths = normalizeStringList(request?.scratchPaths);
  const expectedRuntimeSeconds = normalizePositiveDurationSeconds(request?.expectedRuntimeSeconds);
  const requiresShell = request?.requiresShell === true;
  const inheritedToolAllowlist = normalizeInheritedToolAllowlist(runtime?.inheritedToolAllowlist);
  const inheritedToolDenylist = normalizeInheritedToolDenylist(runtime?.inheritedToolDenylist);
  const reasons: string[] = [];
  const missingTools: string[] = [];
  const blockedPaths: string[] = [];

  const effectiveRequiredTools = new Set(requiredTools);
  if (requiresShell) {
    effectiveRequiredTools.add("exec");
  }
  if (writablePaths.length > 0 || artifactOutputPath || logOutputPath || scratchPaths.length > 0) {
    effectiveRequiredTools.add("write");
  }
  if (readableRoots.length > 0) {
    effectiveRequiredTools.add("read");
  }

  const writeRequested =
    writablePaths.length > 0 ||
    Boolean(artifactOutputPath) ||
    Boolean(logOutputPath) ||
    scratchPaths.length > 0 ||
    [...effectiveRequiredTools].some((tool) => SUBAGENT_PREFLIGHT_WRITE_TOOLS.has(tool));
  const shellRequested =
    requiresShell ||
    [...effectiveRequiredTools].some((tool) => SUBAGENT_PREFLIGHT_SHELL_TOOLS.has(tool));

  if (profile === "read-only" || profile === "image-only") {
    if (writeRequested) {
      reasons.push(`${profile} profile cannot satisfy writable artifact/output requirements`);
    }
    if (shellRequested) {
      reasons.push(`${profile} profile cannot run shell-required checkers`);
    }
  }

  for (const toolName of effectiveRequiredTools) {
    const allowedByRuntime = runtime?.isToolAllowed?.(toolName) ?? true;
    const allowedByInherited = isToolAllowedByInheritedPolicy(
      toolName,
      inheritedToolAllowlist,
      inheritedToolDenylist,
    );
    if (!allowedByRuntime || !allowedByInherited) {
      missingTools.push(toolName);
    }
  }
  if (missingTools.length > 0) {
    reasons.push(
      `required tool(s) unavailable: ${[...new Set(missingTools)].toSorted().join(", ")}`,
    );
  }

  if (expectedRuntimeSeconds && runtime?.runTimeoutSeconds && runtime.runTimeoutSeconds > 0) {
    if (expectedRuntimeSeconds > runtime.runTimeoutSeconds) {
      reasons.push(
        `expected runtime ${expectedRuntimeSeconds}s exceeds spawn timeout ${runtime.runTimeoutSeconds}s`,
      );
    }
  }

  for (const root of readableRoots) {
    const resolved = resolvePathForPreflight(root, runtime?.workspaceDir);
    if (!resolved || !isPathAccessible(resolved, fs.constants.R_OK)) {
      blockedPaths.push(root);
      reasons.push(`readable root is unavailable: ${root}`);
    }
  }

  const writableCandidates = [...writablePaths, ...scratchPaths];
  if (artifactOutputPath) {
    writableCandidates.push(artifactOutputPath);
  }
  if (logOutputPath) {
    writableCandidates.push(logOutputPath);
  }
  for (const candidate of writableCandidates) {
    const checkPath = resolveWritableCheckPath(candidate, runtime?.workspaceDir);
    if (!checkPath || !isPathAccessible(checkPath, fs.constants.W_OK | fs.constants.R_OK)) {
      blockedPaths.push(candidate);
      reasons.push(`writable/readable path is unavailable: ${candidate}`);
    }
  }

  const declaredWritableRoots = [...writablePaths, ...scratchPaths];
  if (artifactOutputPath && declaredWritableRoots.length > 0) {
    const artifactAbsPath = resolvePathForPreflight(artifactOutputPath, runtime?.workspaceDir);
    const insideWritableRoot = declaredWritableRoots.some((writablePath) => {
      const writableAbsPath = resolvePathForPreflight(writablePath, runtime?.workspaceDir);
      return writableAbsPath && isPathEqualOrInside(artifactAbsPath, writableAbsPath);
    });
    if (!insideWritableRoot) {
      blockedPaths.push(artifactOutputPath);
      reasons.push("artifact output path is outside declared writable/scratch paths");
    }
  }

  if (logOutputPath && declaredWritableRoots.length > 0) {
    const logAbsPath = resolvePathForPreflight(logOutputPath, runtime?.workspaceDir);
    const insideWritableRoot = declaredWritableRoots.some((writablePath) => {
      const writableAbsPath = resolvePathForPreflight(writablePath, runtime?.workspaceDir);
      return writableAbsPath && isPathEqualOrInside(logAbsPath, writableAbsPath);
    });
    if (!insideWritableRoot) {
      blockedPaths.push(logOutputPath);
      reasons.push("log output path is outside declared writable/scratch paths");
    }
  }

  if (reasons.length > 0) {
    return makePreflightFailure({ reasons, missingTools, blockedPaths });
  }

  return {
    ok: true,
    normalized: {
      profile,
      requiredTools: [...effectiveRequiredTools].toSorted(),
      writablePaths,
      readableRoots,
      scratchPaths,
      ...(artifactOutputPath ? { artifactOutputPath } : {}),
      ...(logOutputPath ? { logOutputPath } : {}),
      ...(expectedRuntimeSeconds ? { expectedRuntimeSeconds } : {}),
      requiresShell,
    },
  };
}

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

function shouldInspectStoredSubagentEnvelope(sessionKey: string): boolean {
  return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}

function isSameAgentSessionStore(leftSessionKey: string, rightSessionKey: string): boolean {
  const leftAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(leftSessionKey)?.agentId,
  );
  const rightAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(rightSessionKey)?.agentId,
  );
  return Boolean(leftAgentId) && leftAgentId === rightAgentId;
}

function readSessionStore(storePath: string): Record<string, SessionCapabilityEntry> {
  try {
    return loadSessionStore(storePath);
  } catch {
    return {};
  }
}

function findEntryBySessionId(
  store: SessionCapabilityStore,
  sessionId: string,
): SessionCapabilityEntry | undefined {
  const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeSubagentSessionKey(entry?.sessionId);
    if (candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveSessionCapabilityEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: SessionCapabilityStore;
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

export function resolveSubagentCapabilityStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): SessionCapabilityStore | undefined {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return opts?.store;
  }
  if (opts?.store) {
    return opts.store;
  }
  if (!opts?.cfg || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveStorePath(opts.cfg.session?.store, { agentId: parsed.agentId });
  return readSessionStore(storePath);
}

function resolveSubagentRoleForDepth(params: {
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

function resolveSubagentControlScopeForRole(role: SubagentSessionRole): SubagentControlScope {
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
  };
}

function isStoredSubagentEnvelopeSession(
  params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
  visited = new Set<string>(),
): boolean {
  const normalizedSessionKey = normalizeSubagentSessionKey(params.sessionKey);
  if (!normalizedSessionKey || visited.has(normalizedSessionKey)) {
    return false;
  }
  visited.add(normalizedSessionKey);

  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  if (!isAcpSessionKey(normalizedSessionKey)) {
    return false;
  }

  const entry =
    params.entry ??
    resolveSessionCapabilityEntry({
      sessionKey: normalizedSessionKey,
      cfg: params.cfg,
      store: params.store,
    });
  if (
    normalizeSubagentRole(entry?.subagentRole) ||
    normalizeSubagentControlScope(entry?.subagentControlScope)
  ) {
    return true;
  }

  const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
  if (!spawnedBy) {
    return false;
  }
  const parentStore = isSameAgentSessionStore(normalizedSessionKey, spawnedBy)
    ? params.store
    : undefined;
  return isStoredSubagentEnvelopeSession(
    {
      sessionKey: spawnedBy,
      cfg: params.cfg,
      store: parentStore,
    },
    visited,
  );
}

export function isSubagentEnvelopeSession(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
): boolean {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return false;
  }
  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  if (!isAcpSessionKey(normalizedSessionKey)) {
    return false;
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  return isStoredSubagentEnvelopeSession({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
    entry: opts?.entry,
  });
}

export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
) {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  const maxSpawnDepth =
    opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (!normalizedSessionKey) {
    return resolveSubagentCapabilities({ depth: 0, maxSpawnDepth });
  }
  if (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
      cfg: opts?.cfg,
      store: opts?.store,
    });
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = normalizedSessionKey
    ? resolveSessionCapabilityEntry({
        sessionKey: normalizedSessionKey,
        cfg: opts?.cfg,
        store,
      })
    : undefined;
  const depthStore = opts?.cfg && typeof entry?.spawnDepth !== "number" ? undefined : store;
  const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
    cfg: opts?.cfg,
    store: depthStore,
  });
  if (!isSubagentEnvelopeSession(normalizedSessionKey, { ...opts, store, entry })) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const storedRole = normalizeSubagentRole(entry?.subagentRole);
  const storedControlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
  const fallback = resolveSubagentCapabilities({ depth, maxSpawnDepth });
  const role = storedRole ?? fallback.role;
  const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);
  return {
    depth,
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

export function resolveStoredSubagentInheritedToolDenylist(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): string[] {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return [];
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  return normalizeInheritedToolDenylist(entry?.inheritedToolDeny);
}

export function resolveStoredSubagentInheritedToolAllowlist(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): string[] {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return [];
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  return normalizeInheritedToolAllowlist(entry?.inheritedToolAllow);
}
