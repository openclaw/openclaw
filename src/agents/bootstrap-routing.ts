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

/**
 * Resolves workspace bootstrap routing after checking pending state and
 * loaded bootstrap files. Content can prove bootstrap is pending; callers
 * decide whether that content also proves the run can complete file changes.
 */
export async function resolveWorkspaceBootstrapRouting(params: {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
  bootstrapFilesProvideAccess?: boolean;
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
}): Promise<{
  bootstrapMode: BootstrapMode;
  /** Routing withholds no workspace bootstrap content. Readability is checked after loading. */
  deliversCompleteWorkspaceContext: boolean;
  includeBootstrapInSystemContext: boolean;
}> {
  const hasBootstrapContent =
    params.bootstrapFiles?.some(
      (file) =>
        file.name === DEFAULT_BOOTSTRAP_FILENAME &&
        !file.missing &&
        typeof file.content === "string" &&
        file.content.trim().length > 0,
    ) ?? false;
  const workspaceBootstrapPending =
    hasBootstrapContent || (await params.isWorkspaceBootstrapPending(params.resolvedWorkspace));
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending: workspaceBootstrapPending,
    runKind: params.bootstrapContextRunKind ?? "default",
    isInteractiveUserFacing: params.trigger === "user" || params.trigger === "manual",
    isPrimaryRun: params.isPrimaryRun,
    isCanonicalWorkspace:
      (params.isCanonicalWorkspace ?? true) &&
      params.effectiveWorkspace === params.resolvedWorkspace,
    hasBootstrapFileAccess:
      params.hasBootstrapFileAccess ||
      (params.bootstrapFilesProvideAccess !== false && hasBootstrapContent),
  });
  return {
    bootstrapMode,
    // Completed workspaces deliver context even though they no longer need onboarding.
    deliversCompleteWorkspaceContext: bootstrapMode === "full" || !workspaceBootstrapPending,
    includeBootstrapInSystemContext: bootstrapMode === "full",
  };
}
