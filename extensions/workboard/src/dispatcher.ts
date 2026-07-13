// Workboard plugin module implements dispatcher behavior.
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { WorkboardStore, type WorkboardDispatchResult } from "./store.js";
import type { WorkboardCard, WorkboardExecution, WorkboardWorkspace } from "./types.js";

const DEFAULT_DISPATCH_MAX_STARTS = 3;
const DEFAULT_DISPATCH_OWNER = "workboard-dispatcher";
const DEFAULT_DISPATCH_MODEL = "default";

export type WorkboardSubagentRuntime = Pick<PluginRuntime["subagent"], "run">;
export type WorkboardWorktreeRuntime = PluginRuntime["worktrees"];

type WorkboardDispatchStartOptions = {
  maxStarts?: number;
  model?: string;
  provider?: string;
  ownerId?: string;
  boardId?: string;
  now?: number;
  allowManagedWorktrees?: boolean;
};

type WorkboardStartedRun = {
  cardId: string;
  title: string;
  sessionKey: string;
  runId: string;
};

type WorkboardStartFailure = {
  cardId: string;
  title: string;
  error: string;
};

type WorkboardDispatchAndStartResult = WorkboardDispatchResult & {
  started: WorkboardStartedRun[];
  startFailures: WorkboardStartFailure[];
};

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function cardBoardId(card: WorkboardCard): string {
  return card.metadata?.automation?.boardId ?? "default";
}

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

function cardIsArchived(card: WorkboardCard): boolean {
  return Boolean(card.metadata?.archivedAt);
}

function buildSessionKey(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function buildExecution(params: {
  card: WorkboardCard;
  sessionKey: string;
  runId: string;
  model: string;
  now: number;
}): WorkboardExecution {
  return {
    id: params.card.execution?.id ?? `${params.card.id}:codex`,
    kind: "agent-session",
    engine: "codex",
    mode: "autonomous",
    status: "running",
    model: params.model,
    sessionKey: params.sessionKey,
    runId: params.runId,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

function managedWorktreeName(cardId: string): string {
  const suffix = cardId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return `wb-${suffix}`.slice(0, 64).replace(/-$/, "");
}

async function materializeWorkspace(params: {
  card: WorkboardCard;
  worktrees?: WorkboardWorktreeRuntime;
  allowManagedWorktrees: boolean;
}): Promise<{ workspace?: WorkboardWorkspace; cwd?: string }> {
  const workspace = params.card.metadata?.automation?.workspace;
  if (workspace?.kind !== "worktree") {
    return {};
  }
  if (!params.allowManagedWorktrees) {
    throw new Error("managed worktree dispatch requires operator.admin");
  }
  const sourcePath = workspace.sourcePath ?? workspace.path;
  const sourceBranch = workspace.sourcePath ? workspace.sourceBranch : workspace.branch;
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    throw new Error("worktree workspace path must be an absolute git checkout path");
  }
  if (!params.worktrees) {
    throw new Error("managed worktree runtime is unavailable");
  }
  const worktree = await params.worktrees.create({
    repoRoot: sourcePath,
    name: managedWorktreeName(params.card.id),
    ...(sourceBranch ? { baseRef: sourceBranch } : {}),
    ownerKind: "workboard",
    ownerId: params.card.id,
  });
  return {
    cwd: worktree.path,
    workspace: {
      kind: "worktree",
      path: worktree.path,
      branch: worktree.branch,
      sourcePath,
      ...(sourceBranch ? { sourceBranch } : {}),
    },
  };
}

function buildWorkerPrompt(params: {
  card: WorkboardCard;
  context: string;
  ownerId: string;
  token: string;
}): string {
  return [
    `Work on this OpenClaw Workboard card: ${params.card.title}`,
    "",
    "## Worker protocol",
    `Card id: ${params.card.id}`,
    `Claim ownerId: ${params.ownerId}`,
    `Claim token: ${params.token}`,
    "",
    "Heartbeat with workboard_heartbeat using the card id and token while working.",
    "When done, call workboard_complete with the card id, token, summary, and proof.",
    "If blocked, call workboard_block with the card id, token, and reason.",
    "",
    params.context,
  ].join("\n");
}

function sortReadyCards(a: WorkboardCard, b: WorkboardCard): number {
  const priorityRank: Record<WorkboardCard["priority"], number> = {
    urgent: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  return (
    priorityRank[a.priority] - priorityRank[b.priority] ||
    a.position - b.position ||
    a.createdAt - b.createdAt
  );
}

function selectStartableCards(
  cards: WorkboardCard[],
  limit: number,
  candidates: WorkboardCard[] = cards,
): WorkboardCard[] {
  if (limit <= 0) {
    return [];
  }
  const runningByOwner = new Map<string, number>();
  for (const card of cards) {
    const consumesOwnerSlot =
      card.status === "running" ||
      Boolean(card.metadata?.claim) ||
      card.execution?.status === "running";
    if (!consumesOwnerSlot || cardIsArchived(card)) {
      continue;
    }
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    runningByOwner.set(owner, (runningByOwner.get(owner) ?? 0) + 1);
  }
  const selected: WorkboardCard[] = [];
  for (const card of candidates
    .filter((entry) => entry.status === "ready" && !entry.metadata?.claim && !cardIsArchived(entry))
    .toSorted(sortReadyCards)) {
    const owner = card.agentId ?? DEFAULT_DISPATCH_OWNER;
    if ((runningByOwner.get(owner) ?? 0) > 0) {
      continue;
    }
    selected.push(card);
    runningByOwner.set(owner, 1);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardSubagentRuntime;
  worktrees?: WorkboardWorktreeRuntime;
  options?: WorkboardDispatchStartOptions;
}): Promise<WorkboardDispatchAndStartResult> {
  const now = params.options?.now ?? Date.now();
  const boardId = params.options?.boardId;
  const dispatch = await params.store.dispatch({ now, boardId });
  const maxStarts = normalizePositiveInteger(
    params.options?.maxStarts,
    DEFAULT_DISPATCH_MAX_STARTS,
  );
  const started: WorkboardStartedRun[] = [];
  const startFailures: WorkboardStartFailure[] = [];
  const model = params.options?.model?.trim() || DEFAULT_DISPATCH_MODEL;
  const cards = await params.store.list();
  const candidates = await params.store.list({ boardId });

  for (const card of selectStartableCards(cards, maxStarts, candidates)) {
    const ownerId = params.options?.ownerId?.trim() || card.agentId || DEFAULT_DISPATCH_OWNER;
    const sessionKey = buildSessionKey(card);
    let token = "";
    let materializedWorkspace: WorkboardWorkspace | undefined;
    let runStarted = false;
    if (
      card.metadata?.automation?.workspace?.kind === "worktree" &&
      params.options?.allowManagedWorktrees === false
    ) {
      startFailures.push({
        cardId: card.id,
        title: card.title,
        error: "managed worktree dispatch requires operator.admin",
      });
      continue;
    }
    try {
      const claimed = await params.store.claim(card.id, {
        ownerId,
        ttlSeconds: card.metadata?.automation?.maxRuntimeSeconds,
      });
      token = claimed.token;
      const context = await params.store.buildWorkerContext(card.id);
      const materialized = await materializeWorkspace({
        card: claimed.card,
        worktrees: params.worktrees,
        allowManagedWorktrees: params.options?.allowManagedWorktrees !== false,
      });
      materializedWorkspace = materialized.workspace;
      if (materializedWorkspace) {
        await params.store.update(card.id, { workspace: materializedWorkspace });
      }
      const run = await params.subagent.run({
        sessionKey,
        message: buildWorkerPrompt({
          card: claimed.card,
          context,
          ownerId,
          token,
        }),
        ...(params.options?.provider ? { provider: params.options.provider } : {}),
        ...(params.options?.model ? { model: params.options.model } : {}),
        lane: `workboard:${cardBoardId(card)}:${card.id}`,
        idempotencyKey: `workboard:${card.id}:${claimed.card.updatedAt}`,
        lightContext: true,
        deliver: false,
        ...(materialized.cwd ? { cwd: materialized.cwd } : {}),
      });
      runStarted = true;
      const updated = await params.store.update(card.id, {
        sessionKey,
        runId: run.runId,
        execution: buildExecution({
          card: claimed.card,
          sessionKey,
          runId: run.runId,
          model,
          now,
        }),
        ...(materializedWorkspace ? { workspace: materializedWorkspace } : {}),
      });
      await params.store.addWorkerLog(
        updated.id,
        {
          level: "info",
          message: `Dispatcher started subagent run ${run.runId}.`,
          sessionKey,
          runId: run.runId,
        },
        { ownerId, token },
      );
      started.push({
        cardId: updated.id,
        title: updated.title,
        sessionKey,
        runId: run.runId,
      });
    } catch (error) {
      if (!runStarted && materializedWorkspace?.path && params.worktrees) {
        await params.worktrees
          .removeIfLossless({ path: materializedWorkspace.path })
          .catch(() => undefined);
        const sourceWorkspace = card.metadata?.automation?.workspace;
        if (sourceWorkspace) {
          await params.store.update(card.id, { workspace: sourceWorkspace }).catch(() => undefined);
        }
      }
      const message = formatErrorMessage(error);
      startFailures.push({ cardId: card.id, title: card.title, error: message });
      if (!token) {
        continue;
      }
      try {
        await params.store.block(
          card.id,
          {
            ownerId,
            token,
            reason: `Dispatcher could not start worker: ${message}`,
          },
          { ownerId, token },
        );
      } catch {
        // Leave the original start failure visible; dispatch will diagnose stale claims later.
      }
    }
  }

  return {
    ...dispatch,
    started,
    startFailures,
    count: dispatch.count + started.length + startFailures.length,
  };
}

export async function cleanupWorkboardRunWorktree(params: {
  store: WorkboardStore;
  worktrees: WorkboardWorktreeRuntime;
  runId: string;
}): Promise<void> {
  const card = (await params.store.list()).find((entry) => entry.runId === params.runId);
  const workspace = card?.metadata?.automation?.workspace;
  if (workspace?.kind !== "worktree" || !workspace.path) {
    return;
  }
  await params.worktrees.removeIfLossless({ path: workspace.path });
}
