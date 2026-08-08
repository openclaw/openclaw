import type { WorkboardCard } from "@openclaw/workboard-contract";
// Workboard dispatch workspace helpers keep authority resolution outside the orchestration loop.
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { canonicalPathFromExistingAncestor } from "openclaw/plugin-sdk/security-runtime";
import type { WorkboardStore } from "./store.js";
import {
  assertCanonicalWorkboardRootAccess,
  canonicalizeWorkboardWorkspaceAccess,
  intersectWorkboardWorkspaceAccess,
  type WorkboardTargetWorkspaceRuntime,
  type WorkboardWorkspaceAccess,
} from "./workspace-access.js";

export type ResolveAgentWorkspaceRuntime = (
  agentId: string | undefined,
  sessionKey: string,
  workspaceDir: string,
  modelProvider?: string,
  modelId?: string,
) => WorkboardTargetWorkspaceRuntime | Promise<WorkboardTargetWorkspaceRuntime>;

export function managedWorktreeName(cardId: string): string {
  const suffix = cardId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return `wb-${suffix}`.slice(0, 64).replace(/-$/, "");
}

export async function cleanupWorkboardRunWorktree(params: {
  store: WorkboardStore;
  worktrees: Pick<PluginRuntime["worktrees"], "removeIfLossless">;
  runId: string;
}): Promise<void> {
  const card = (await params.store.list()).find((entry) => entry.runId === params.runId);
  const workspace = card?.metadata?.automation?.workspace;
  if (!card || workspace?.kind !== "worktree" || !workspace.path) {
    return;
  }
  await params.worktrees.removeIfLossless({
    path: workspace.path,
    ownerKind: "workboard",
    ownerId: card.id,
  });
}

type WorkboardTerminalRunEvent = {
  runId: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

const MAX_PENDING_TERMINAL_RUNS = 64;
const pendingTerminalRunEvents = new WeakMap<
  WorkboardStore,
  Map<string, WorkboardTerminalRunEvent>
>();

function rememberPendingTerminalRun(store: WorkboardStore, event: WorkboardTerminalRunEvent): void {
  let events = pendingTerminalRunEvents.get(store);
  if (!events) {
    events = new Map();
    pendingTerminalRunEvents.set(store, events);
  }
  if (events.has(event.runId)) {
    return;
  }
  events.set(event.runId, event);
  const oldestRunId = events.keys().next().value;
  if (events.size > MAX_PENDING_TERMINAL_RUNS && oldestRunId) {
    events.delete(oldestRunId);
  }
}

function terminalRunReason(event: WorkboardTerminalRunEvent): string {
  const error = event.error?.trim().slice(0, 1200);
  if (error) {
    return `Subagent run ended with an error before recording a Workboard terminal action: ${error}`;
  }
  switch (event.outcome) {
    case "timeout":
      return "Subagent run timed out before recording a Workboard terminal action.";
    case "killed":
      return "Subagent run was killed before recording a Workboard terminal action.";
    case "reset":
      return "Subagent run was reset before recording a Workboard terminal action.";
    case "deleted":
      return "Subagent run was deleted before recording a Workboard terminal action.";
    case "error":
      return "Subagent run failed before recording a Workboard terminal action.";
    default:
      return "Subagent run completed without recording workboard_complete or workboard_block.";
  }
}

export async function reconcileWorkboardTerminalRun(params: {
  store: WorkboardStore;
  event: WorkboardTerminalRunEvent;
}): Promise<void> {
  const card = await params.store.blockTerminalRun(
    params.event.runId,
    terminalRunReason(params.event),
  );
  if (!card) {
    // `subagent_ended` can arrive after run() resolves but before dispatch
    // records the run id. Retain this owner-local event for that exact write.
    rememberPendingTerminalRun(params.store, params.event);
  }
}

export async function reconcilePendingWorkboardTerminalRun(params: {
  store: WorkboardStore;
  runId: string;
}): Promise<WorkboardTerminalRunEvent | undefined> {
  const events = pendingTerminalRunEvents.get(params.store);
  const event = events?.get(params.runId);
  if (!event) {
    return undefined;
  }
  events?.delete(params.runId);
  const card = await params.store.blockTerminalRun(event.runId, terminalRunReason(event));
  return card ? event : undefined;
}

export async function resolveDispatchWorkspaceAccess(params: {
  card: WorkboardCard;
  currentAccess?: WorkboardWorkspaceAccess;
  resolveAgentWorkspace?: (agentId?: string) => string;
}): Promise<{
  workspaceAccess: WorkboardWorkspaceAccess;
  targetWorkspace?: string;
  persistWorkspaceAccess: boolean;
}> {
  const currentAccess = await canonicalizeWorkboardWorkspaceAccess(
    params.currentAccess ?? { unrestricted: true },
  );
  const persistedAccess = params.card.metadata?.automation?.workspaceAccess;
  const workspace = params.card.metadata?.automation?.workspace;
  let targetWorkspace: string | undefined;
  if (!persistedAccess?.unrestricted || !currentAccess.unrestricted) {
    const resolved = params.resolveAgentWorkspace?.(params.card.agentId);
    targetWorkspace = resolved ? await canonicalPathFromExistingAncestor(resolved) : undefined;
  }
  const cardAccess = persistedAccess
    ? await canonicalizeWorkboardWorkspaceAccess(persistedAccess)
    : currentAccess.unrestricted
      ? !workspace || workspace.kind === "scratch"
        ? currentAccess
        : (() => {
            throw new Error(
              "card workspace authority is unknown; re-save its workspace with current permissions before dispatch.",
            );
          })()
      : currentAccess;
  const workspaceAccess = intersectWorkboardWorkspaceAccess(cardAccess, currentAccess);
  if (!workspaceAccess.unrestricted && !workspaceAccess.writable) {
    throw new Error(
      "card workspace authority is read-only; manual movement is allowed but worker dispatch requires write access.",
    );
  }
  return {
    workspaceAccess,
    ...(targetWorkspace ? { targetWorkspace } : {}),
    persistWorkspaceAccess: !persistedAccess,
  };
}

export async function assertRestrictedWorkboardTarget(params: {
  root: string;
  agentId?: string;
  sessionKey: string;
  modelProvider?: string;
  modelId?: string;
  resolveAgentWorkspaceRuntime?: ResolveAgentWorkspaceRuntime;
  worktrees?: Pick<
    PluginRuntime["worktrees"],
    "resolveCheckoutRoot" | "hasSelfContainedCheckoutMetadata"
  >;
}): Promise<void> {
  const resolved: WorkboardTargetWorkspaceRuntime = params.resolveAgentWorkspaceRuntime
    ? await params.resolveAgentWorkspaceRuntime(
        params.agentId,
        params.sessionKey,
        params.root,
        params.modelProvider,
        params.modelId,
      )
    : {
        sandboxed: false,
        workspaceAccess: { unrestricted: true } as const,
      };
  const targetRuntime = {
    ...resolved,
    workspaceAccess: await canonicalizeWorkboardWorkspaceAccess(resolved.workspaceAccess),
  };
  if (!targetRuntime.sandboxed) {
    throw new Error("target agent is not sandboxed for this restricted Workboard card.");
  }
  if (targetRuntime.confinementError) {
    throw new Error(targetRuntime.confinementError);
  }
  if (targetRuntime.workspaceAccess.unrestricted || !targetRuntime.workspaceAccess.writable) {
    throw new Error("target agent does not have writable workspace-only access.");
  }
  await assertCanonicalWorkboardRootAccess(params.root, targetRuntime.workspaceAccess);
  if (!params.worktrees) {
    throw new Error("workspace checkout inspection is unavailable for restricted dispatch.");
  }
  const checkoutRoot = await params.worktrees.resolveCheckoutRoot({ path: params.root });
  if (!checkoutRoot) {
    return;
  }
  if ((await canonicalPathFromExistingAncestor(checkoutRoot)) !== params.root) {
    throw new Error("workspace root is nested inside a broader Git checkout.");
  }
  if (
    !params.worktrees.hasSelfContainedCheckoutMetadata ||
    !(await params.worktrees.hasSelfContainedCheckoutMetadata({ path: params.root }))
  ) {
    throw new Error("restricted workspace Git metadata must be contained inside its root.");
  }
}
