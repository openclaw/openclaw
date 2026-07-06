/**
 * Resolves workspace bootstrap routing for one agent run. Shared by the
 * embedded attempt runner and CLI-backend runs so both runtimes gate the
 * first reply on a pending BOOTSTRAP.md the same way.
 */
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import type { BootstrapContextRunKind, BootstrapMode } from "./bootstrap-mode.js";
import { resolveBootstrapMode } from "./bootstrap-mode.js";
import { DEFAULT_BOOTSTRAP_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

/**
 * Returns whether a session should receive primary bootstrap context. Subagents
 * and ACP worker sessions inherit/run their own context path instead of getting
 * the top-level bootstrap payload again.
 */
export function isPrimaryBootstrapRun(sessionKey?: string): boolean {
  return !isSubagentSessionKey(sessionKey) && !isAcpSessionKey(sessionKey);
}

/** Inputs that decide whether this run should inject workspace bootstrap context. */
type BootstrapRoutingInput = {
  workspaceBootstrapPending: boolean;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  trigger?: string;
  sessionKey?: string;
  isPrimaryRun: boolean;
  isCanonicalWorkspace?: boolean;
  effectiveWorkspace: string;
  resolvedWorkspace: string;
  hasBootstrapFileAccess: boolean;
};

/** Bootstrap placement decision consumed by system/runtime context assembly. */
export type WorkspaceBootstrapRouting = {
  bootstrapMode: BootstrapMode;
  includeBootstrapInSystemContext: boolean;
  includeBootstrapInRuntimeContext: boolean;
};

type WorkspaceBootstrapRoutingInput = Omit<BootstrapRoutingInput, "workspaceBootstrapPending"> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
  bootstrapFiles?: readonly WorkspaceBootstrapFile[];
};

function resolveBootstrapRouting(params: BootstrapRoutingInput): WorkspaceBootstrapRouting {
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending: params.workspaceBootstrapPending,
    runKind: params.bootstrapContextRunKind ?? "default",
    isInteractiveUserFacing: params.trigger === "user" || params.trigger === "manual",
    isPrimaryRun: params.isPrimaryRun,
    isCanonicalWorkspace:
      (params.isCanonicalWorkspace ?? true) &&
      params.effectiveWorkspace === params.resolvedWorkspace,
    hasBootstrapFileAccess: params.hasBootstrapFileAccess,
  });

  return {
    bootstrapMode,
    includeBootstrapInSystemContext: bootstrapMode === "full",
    includeBootstrapInRuntimeContext: false,
  };
}

/**
 * Resolves workspace bootstrap routing after checking pending state and
 * hook-provided bootstrap files. Hook content counts as both pending bootstrap
 * and file access so generated bootstrap text follows the same route as disk
 * bootstrap content.
 */
export async function resolveWorkspaceBootstrapRouting(
  params: WorkspaceBootstrapRoutingInput,
): Promise<WorkspaceBootstrapRouting> {
  const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(
    params.resolvedWorkspace,
  );
  const hasHookBootstrapContent =
    params.bootstrapFiles?.some(
      (file) =>
        file.name === DEFAULT_BOOTSTRAP_FILENAME &&
        !file.missing &&
        typeof file.content === "string" &&
        file.content.trim().length > 0,
    ) ?? false;
  return resolveBootstrapRouting({
    ...params,
    workspaceBootstrapPending: workspaceBootstrapPending || hasHookBootstrapContent,
    hasBootstrapFileAccess: params.hasBootstrapFileAccess || hasHookBootstrapContent,
  });
}
