/**
 * Resolves workspace bootstrap routing for one agent run. Shared by the
 * embedded attempt runner and CLI-backend runs so both runtimes gate the
 * first reply on a pending BOOTSTRAP.md the same way.
 */
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import {
  isHeartbeatLifecycleRunKind,
  type BootstrapContextRunKind,
  type BootstrapMode,
  resolveBootstrapMode,
} from "./bootstrap-mode.js";
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
  currentInboundEventKind?: InboundEventKind;
  trigger?: string;
  sessionKey?: string;
  isPrimaryRun: boolean;
  isCanonicalWorkspace?: boolean;
  effectiveWorkspace: string;
  resolvedWorkspace: string;
  hasBootstrapFileAccess: boolean;
};

/** Bootstrap placement decision consumed by system/runtime context assembly. */
type WorkspaceBootstrapRouting = {
  bootstrapMode: BootstrapMode;
  includeBootstrapInSystemContext: boolean;
  includeBootstrapInRuntimeContext: boolean;
  isPrimaryInteractiveRun: boolean;
};

type WorkspaceBootstrapRoutingInput = Omit<BootstrapRoutingInput, "workspaceBootstrapPending"> & {
  isWorkspaceBootstrapPending: (workspaceDir: string) => Promise<boolean>;
  bootstrapFiles?: readonly WorkspaceBootstrapFile[];
  bootstrapFilesProvideAccess?: boolean;
};

type BootstrapContextInjection<TBootstrapFile = unknown, TContextFile = unknown> = {
  bootstrapFiles: TBootstrapFile[];
  contextFiles: TContextFile[];
};

export function isPrimaryInteractiveBootstrapRun(params: {
  currentInboundEventKind?: InboundEventKind;
  isPrimaryRun: boolean;
  trigger?: string;
}): boolean {
  // Room events run under the user trigger but deliberately do not persist an
  // assistant turn, so they cannot establish or consume continuation state.
  return (
    params.isPrimaryRun &&
    params.currentInboundEventKind !== "room_event" &&
    (params.trigger === "user" || params.trigger === "manual")
  );
}

function resolveBootstrapRouting(params: BootstrapRoutingInput): WorkspaceBootstrapRouting {
  const isPrimaryInteractiveRun = isPrimaryInteractiveBootstrapRun(params);
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending: params.workspaceBootstrapPending,
    runKind: params.bootstrapContextRunKind ?? "default",
    isInteractiveUserFacing: isPrimaryInteractiveRun,
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
    // Keep this routing fact distinct from bootstrapMode: established workspaces
    // resolve to "none" for both user turns and hidden maintenance runs.
    isPrimaryInteractiveRun,
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

/**
 * Resolves the runtime-independent bootstrap injection decision shared by CLI
 * and embedded runs. Lifecycle owners persist the returned marker separately.
 */
export async function resolveBootstrapContextInjection<TBootstrapFile, TContextFile>(params: {
  contextInjectionMode: "always" | "continuation-skip" | "never";
  bootstrapContextMode?: string;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  bootstrapMode?: BootstrapMode;
  isPrimaryInteractiveRun: boolean;
  hasCompletedBootstrapTurn: () => Promise<boolean>;
  resolveBootstrapContextForRun: () => Promise<
    BootstrapContextInjection<TBootstrapFile, TContextFile>
  >;
}): Promise<
  BootstrapContextInjection<TBootstrapFile, TContextFile> & {
    isContinuationTurn: boolean;
    shouldRecordCompletedBootstrapTurn: boolean;
  }
> {
  const isHeartbeatLifecycleRun = isHeartbeatLifecycleRunKind(params.bootstrapContextRunKind);
  const isEligibleInteractiveBootstrapRun =
    params.isPrimaryInteractiveRun && params.bootstrapContextRunKind !== "cron";
  const isContinuationTurn =
    params.bootstrapMode !== "full" &&
    params.contextInjectionMode === "continuation-skip" &&
    !isHeartbeatLifecycleRun &&
    isEligibleInteractiveBootstrapRun &&
    (await params.hasCompletedBootstrapTurn());
  // Continuation-skip and explicit never both produce an empty injection set,
  // but only a clean full bootstrap later records a durable completion marker.
  const shouldSkipBootstrapInjection =
    params.contextInjectionMode === "never" || isContinuationTurn;
  const shouldRecordEstablishedWorkspaceTurn =
    params.bootstrapMode === "none" &&
    params.contextInjectionMode === "continuation-skip" &&
    isEligibleInteractiveBootstrapRun;
  const shouldRecordCompletedBootstrapTurn =
    !shouldSkipBootstrapInjection &&
    params.bootstrapContextMode !== "lightweight" &&
    !isHeartbeatLifecycleRun &&
    // Established workspaces still inject normal context once. Only a primary
    // user/manual turn may establish state consumed by later continuations.
    (params.bootstrapMode === "full" || shouldRecordEstablishedWorkspaceTurn);

  const context = shouldSkipBootstrapInjection
    ? { bootstrapFiles: [], contextFiles: [] }
    : await params.resolveBootstrapContextForRun();

  return {
    ...context,
    isContinuationTurn,
    shouldRecordCompletedBootstrapTurn,
  };
}
