import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";

export const ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER = "routerSafePreparedRuntimeOwnerPaths";

const HOST_ONLY_OPENCLAW_ROOT = "/srv/openclaw";
const APPROVED_ROUTER_STATE_ROOT = "/home/openclaw/.openclaw";

export type RouterSafePreparedRuntimePathSource =
  | "configured"
  | "prepared"
  | "published"
  | "reply-run"
  | "auth-refresh";

export type RouterSafePreparedRuntimePaths = {
  workspaceDir: string;
  agentDir: string;
  diagnostics: {
    marker: typeof ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER;
    agentId: string;
    stateRoot: string;
    hostOnlyWorkspace: boolean;
    hostOnlyAgentDir: boolean;
    source: RouterSafePreparedRuntimePathSource;
  };
};

export class RouterSafePreparedRuntimePathError extends Error {
  readonly diagnostics: {
    marker: typeof ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER;
    agentId: string;
    reason: "missing-approved-state-root" | "unsafe-approved-state-root";
    stateRoot?: string;
    hostOnlyWorkspace: boolean;
    hostOnlyAgentDir: boolean;
    source: RouterSafePreparedRuntimePathSource;
  };

  constructor(diagnostics: RouterSafePreparedRuntimePathError["diagnostics"]) {
    super(
      `router prepared runtime path blocked: ${diagnostics.reason} agentId=${diagnostics.agentId}`,
    );
    this.name = "RouterSafePreparedRuntimePathError";
    this.diagnostics = diagnostics;
  }
}

export function normalizePathForRouterSafeGuard(value: string): string {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

export function isHostOnlyOpenClawPath(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = normalizePathForRouterSafeGuard(value);
  return (
    normalized === HOST_ONLY_OPENCLAW_ROOT || normalized.startsWith(`${HOST_ONLY_OPENCLAW_ROOT}/`)
  );
}

export function isApprovedRouterStateRoot(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  const normalized = normalizePathForRouterSafeGuard(value);
  return (
    normalized === APPROVED_ROUTER_STATE_ROOT ||
    normalized.startsWith(`${APPROVED_ROUTER_STATE_ROOT}/`)
  );
}

function resolveExplicitRouterStateRoot(env: NodeJS.ProcessEnv): string | undefined {
  const explicitStateRoot = normalizeOptionalString(env.OPENCLAW_STATE_DIR);
  return explicitStateRoot ? normalizePathForRouterSafeGuard(resolveStateDir(env)) : undefined;
}

export function resolveRouterSafePreparedRuntimePaths(params: {
  agentId: string;
  workspaceDir?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  source: RouterSafePreparedRuntimePathSource;
  failClosed?: boolean;
}): RouterSafePreparedRuntimePaths | undefined {
  const agentId = normalizeAgentId(params.agentId);
  const workspaceCandidate = normalizeOptionalString(params.workspaceDir);
  const agentDirCandidate = normalizeOptionalString(params.agentDir);
  const hostOnlyWorkspace = isHostOnlyOpenClawPath(workspaceCandidate);
  const hostOnlyAgentDir = isHostOnlyOpenClawPath(agentDirCandidate);
  if (!hostOnlyWorkspace && !hostOnlyAgentDir) {
    return undefined;
  }

  const env = params.env ?? process.env;
  const stateRoot = resolveExplicitRouterStateRoot(env);
  if (!stateRoot) {
    if (params.failClosed === false) {
      return undefined;
    }
    throw new RouterSafePreparedRuntimePathError({
      marker: ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER,
      agentId,
      reason: "missing-approved-state-root",
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source: params.source,
    });
  }
  if (!isApprovedRouterStateRoot(stateRoot)) {
    if (params.failClosed === false) {
      return undefined;
    }
    throw new RouterSafePreparedRuntimePathError({
      marker: ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER,
      agentId,
      reason: "unsafe-approved-state-root",
      stateRoot,
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source: params.source,
    });
  }

  return {
    workspaceDir: path.join(stateRoot, "agents", agentId, "workspace"),
    agentDir: path.join(stateRoot, "agents", agentId, "agent"),
    diagnostics: {
      marker: ROUTER_SAFE_PREPARED_RUNTIME_PATHS_MARKER,
      agentId,
      stateRoot,
      hostOnlyWorkspace,
      hostOnlyAgentDir,
      source: params.source,
    },
  };
}
