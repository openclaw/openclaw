// Workboard plugin module implements dispatcher behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { WorkboardStore, type WorkboardDispatchResult } from "./store.js";
import type { WorkboardCard, WorkboardExecution } from "./types.js";

const DEFAULT_DISPATCH_MAX_STARTS = 3;
const DEFAULT_DISPATCH_OWNER = "workboard-dispatcher";
const DEFAULT_DISPATCH_MODEL = "default";

export type WorkboardSubagentRuntime = Pick<PluginRuntime["subagent"], "run">;

export type WorkboardDispatchStartOptions = {
  cardIds?: string[];
  maxStarts?: number;
  model?: string;
  provider?: string;
  ownerId?: string;
  boardId?: string;
  now?: number;
};

export type WorkboardStartedRun = {
  cardId: string;
  title: string;
  sessionKey: string;
  runId: string;
};

export type WorkboardStartFailure = {
  cardId: string;
  title: string;
  error: string;
};

export type WorkboardSkippedStart = {
  cardId: string;
  title: string;
  reason: string;
};

export type WorkboardDispatchAndStartResult = WorkboardDispatchResult & {
  started: WorkboardStartedRun[];
  startFailures: WorkboardStartFailure[];
  skipped: WorkboardSkippedStart[];
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

function ownerSlotOwner(card: WorkboardCard): string {
  return card.agentId ?? card.metadata?.claim?.ownerId ?? DEFAULT_DISPATCH_OWNER;
}

function ownerSlotKey(card: WorkboardCard): string {
  return `${cardBoardId(card)}\0${ownerSlotOwner(card)}`;
}

function cardConsumesOwnerSlot(card: WorkboardCard): boolean {
  if (cardIsArchived(card)) {
    return false;
  }
  return (
    card.status === "running" ||
    card.execution?.status === "running" ||
    (card.status === "review" && Boolean(card.metadata?.claim))
  );
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
  options: { includeSkipped?: boolean } = {},
): { selected: WorkboardCard[]; skipped: WorkboardSkippedStart[] } {
  const skipped: WorkboardSkippedStart[] = [];
  const maybeSkip = (card: WorkboardCard, reason: string) => {
    if (options.includeSkipped) {
      skipped.push({ cardId: card.id, title: card.title, reason });
    }
  };
  if (limit <= 0) {
    for (const card of candidates) {
      maybeSkip(card, "Dispatch start limit is zero.");
    }
    return { selected: [], skipped };
  }
  const runningByOwner = new Map<string, WorkboardCard>();
  for (const card of cards) {
    if (!cardConsumesOwnerSlot(card)) {
      continue;
    }
    const key = ownerSlotKey(card);
    if (!runningByOwner.has(key)) {
      runningByOwner.set(key, card);
    }
  }
  const selected: WorkboardCard[] = [];
  for (const card of candidates.toSorted(sortReadyCards)) {
    if (cardIsArchived(card)) {
      maybeSkip(card, "Card is archived.");
      continue;
    }
    if (card.status !== "ready") {
      maybeSkip(card, `Card status is ${card.status}, not ready.`);
      continue;
    }
    if (card.metadata?.claim) {
      maybeSkip(card, `Card is already claimed by ${card.metadata.claim.ownerId}.`);
      continue;
    }
    if (selected.length >= limit) {
      maybeSkip(card, "Dispatch start limit reached.");
      continue;
    }
    const owner = ownerSlotOwner(card);
    const board = cardBoardId(card);
    const blocker = runningByOwner.get(ownerSlotKey(card));
    if (blocker) {
      maybeSkip(card, `Owner ${owner} already has active work on board ${board}: ${blocker.id}.`);
      continue;
    }
    selected.push(card);
    runningByOwner.set(ownerSlotKey(card), card);
  }
  return { selected, skipped };
}

export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardSubagentRuntime;
  options?: WorkboardDispatchStartOptions;
}): Promise<WorkboardDispatchAndStartResult> {
  const now = params.options?.now ?? Date.now();
  const boardId = params.options?.boardId;
  const targetCardIds = new Set(
    (params.options?.cardIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const dispatch = await params.store.dispatch({
    now,
    boardId,
    cardIds: targetCardIds.size > 0 ? [...targetCardIds] : undefined,
  });
  const maxStarts = normalizePositiveInteger(
    params.options?.maxStarts,
    DEFAULT_DISPATCH_MAX_STARTS,
  );
  const started: WorkboardStartedRun[] = [];
  const startFailures: WorkboardStartFailure[] = [];
  const model = params.options?.model?.trim() || DEFAULT_DISPATCH_MODEL;
  const cards = await params.store.list();
  const candidates = (await params.store.list({ boardId })).filter(
    (card) => targetCardIds.size === 0 || targetCardIds.has(card.id),
  );
  const selection = selectStartableCards(cards, maxStarts, candidates, {
    includeSkipped: targetCardIds.size > 0,
  });
  const skipped = selection.skipped;

  for (const skip of skipped) {
    try {
      await params.store.addWorkerLog(skip.cardId, {
        level: "warning",
        message: `Dispatcher skipped worker start: ${skip.reason}`,
      });
    } catch {
      // Skip reasons are still returned to the caller even if metadata logging fails.
    }
  }

  for (const card of selection.selected) {
    const ownerId = params.options?.ownerId?.trim() || card.agentId || DEFAULT_DISPATCH_OWNER;
    const sessionKey = buildSessionKey(card);
    let token = "";
    try {
      const claimed = await params.store.claim(card.id, {
        ownerId,
        ttlSeconds: card.metadata?.automation?.maxRuntimeSeconds,
      });
      token = claimed.token;
      const context = await params.store.buildWorkerContext(card.id);
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
      });
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
    skipped,
    count: dispatch.count + started.length + startFailures.length + skipped.length,
  };
}
