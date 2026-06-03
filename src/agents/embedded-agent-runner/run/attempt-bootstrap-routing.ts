import type { BootstrapMode } from "../../bootstrap-mode.js";
import { resolveBootstrapMode } from "../../bootstrap-mode.js";
import { DEFAULT_BOOTSTRAP_FILENAME, type WorkspaceBootstrapFile } from "../../workspace.js";

/**
 * Inputs that decide whether BOOTSTRAP.md should influence the current attempt.
 * Both effective and resolved workspaces are carried so sandbox copies do not
 * accidentally make bootstrap pending for the canonical workspace.
 */
export type AttemptBootstrapRoutingInput = {
  workspaceBootstrapPending: boolean;
  bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
  trigger?: string;
  sessionKey?: string;
  isPrimaryRun: boolean;
  isCanonicalWorkspace?: boolean;
  effectiveWorkspace: string;
  resolvedWorkspace: string;
  hasBootstrapFileAccess: boolean;
};

/** Bootstrap mode plus the specific context channel allowed to carry it. */
export type AttemptBootstrapRouting = {
  bootstrapMode: BootstrapMode;
  includeBootstrapInSystemContext: boolean;
  includeBootstrapInRuntimeContext: boolean;
};

/**
 * Async bootstrap-routing inputs for callers that must probe the workspace on
 * demand. Hook-provided bootstrap files can still satisfy the file-access side
 * of the decision when normal reads are unavailable.
 */
export type AttemptWorkspaceBootstrapRoutingInput = Omit<
  AttemptBootstrapRoutingInput,
  "workspaceBootstrapPending"
> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
  bootstrapFiles?: readonly WorkspaceBootstrapFile[];
};

/**
 * Maps resolved bootstrap mode to prompt-context placement. Full bootstrap
 * belongs in the stable Project Context section; runtime context stays reserved
 * for dynamic per-turn state.
 */
export function resolveBootstrapContextTargets(params: {
  bootstrapMode: BootstrapMode;
}): Pick<
  AttemptBootstrapRouting,
  "includeBootstrapInSystemContext" | "includeBootstrapInRuntimeContext"
> {
  return {
    includeBootstrapInSystemContext: params.bootstrapMode === "full",
    includeBootstrapInRuntimeContext: false,
  };
}

function resolveAttemptBootstrapRouting(
  params: AttemptBootstrapRoutingInput,
): AttemptBootstrapRouting {
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
    ...resolveBootstrapContextTargets({ bootstrapMode }),
  };
}

/**
 * Detects meaningful hook-supplied BOOTSTRAP.md content. Empty, missing, or
 * differently named files should not make bootstrap pending.
 */
export function hasBootstrapFileContent(files?: readonly WorkspaceBootstrapFile[]): boolean {
  return (
    files?.some(
      (file) =>
        file.name === DEFAULT_BOOTSTRAP_FILENAME &&
        !file.missing &&
        typeof file.content === "string" &&
        file.content.trim().length > 0,
    ) ?? false
  );
}

/**
 * Resolves bootstrap routing against the canonical workspace plus any hook
 * injected bootstrap content. Hook content counts as readable bootstrap data so
 * setup turns can still receive full context in sandboxed or virtual workspaces.
 */
export async function resolveAttemptWorkspaceBootstrapRouting(
  params: AttemptWorkspaceBootstrapRoutingInput,
): Promise<AttemptBootstrapRouting> {
  const workspaceBootstrapPending = await params.isWorkspaceBootstrapPending(
    params.resolvedWorkspace,
  );
  const hasHookBootstrapContent = hasBootstrapFileContent(params.bootstrapFiles);
  return resolveAttemptBootstrapRouting({
    ...params,
    workspaceBootstrapPending: workspaceBootstrapPending || hasHookBootstrapContent,
    hasBootstrapFileAccess: params.hasBootstrapFileAccess || hasHookBootstrapContent,
  });
}
