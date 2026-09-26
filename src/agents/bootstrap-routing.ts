/**
 * Resolves workspace bootstrap routing for one agent run. Shared by the
 * embedded attempt runner and CLI-backend runs so both runtimes gate the
 * first reply on a pending BOOTSTRAP.md the same way.
 */
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import type { BootstrapContextRunKind, BootstrapMode } from "./bootstrap-mode.js";
import { resolveBootstrapMode } from "./bootstrap-mode.js";
import { isUnreadableWorkspaceBootstrapFile } from "./workspace-bootstrap-read.js";
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
  /** Bootstrap files loaded for this run, when the run has read them already. */
  bootstrapFiles?: readonly WorkspaceBootstrapFile[];
};

/** Bootstrap placement decision consumed by system/runtime context assembly. */
type WorkspaceBootstrapRouting = {
  bootstrapMode: BootstrapMode;
  /** Every workspace bootstrap file reached the prompt, so a continuation can skip re-injection. */
  deliversCompleteWorkspaceContext: boolean;
  includeBootstrapInSystemContext: boolean;
  includeBootstrapInRuntimeContext: boolean;
};

type WorkspaceBootstrapRoutingInput = Omit<BootstrapRoutingInput, "workspaceBootstrapPending"> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
  bootstrapFilesProvideAccess?: boolean;
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
    // "none" with nothing pending means no BOOTSTRAP.md content was withheld, and a guarded-read
    // placeholder means what reached the prompt was the fault report rather than the file.
    deliversCompleteWorkspaceContext:
      (bootstrapMode === "full" || !params.workspaceBootstrapPending) &&
      !(params.bootstrapFiles ?? []).some(isUnreadableWorkspaceBootstrapFile),
    includeBootstrapInSystemContext: bootstrapMode === "full",
    includeBootstrapInRuntimeContext: false,
  };
}

/**
 * Resolves workspace bootstrap routing after checking pending state and
 * loaded bootstrap files. Content can prove bootstrap is pending; callers
 * decide whether that content also proves the run can complete file changes.
 */
export async function resolveWorkspaceBootstrapRouting(
  params: WorkspaceBootstrapRoutingInput,
): Promise<WorkspaceBootstrapRouting> {
  const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(
    params.resolvedWorkspace,
  );
  const hasBootstrapContent =
    params.bootstrapFiles?.some(
      (file) =>
        file.name === DEFAULT_BOOTSTRAP_FILENAME &&
        !file.missing &&
        typeof file.content === "string" &&
        file.content.trim().length > 0,
    ) ?? false;
  return resolveBootstrapRouting({
    ...params,
    workspaceBootstrapPending: workspaceBootstrapPending || hasBootstrapContent,
    hasBootstrapFileAccess:
      params.hasBootstrapFileAccess ||
      (params.bootstrapFilesProvideAccess !== false && hasBootstrapContent),
  });
}
