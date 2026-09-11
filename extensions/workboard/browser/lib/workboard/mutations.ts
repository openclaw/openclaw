import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isGatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  changedDraftPayload,
  draftPayload,
  planWorkboardCardDrop,
  rebaseWorkboardDraft,
  removeCardAndReferences,
  replaceCard,
  resetDraftState,
  selectedWorkboardBoardParams,
  setWorkboardCards,
} from "./card-state.ts";
import { loadWorkboard } from "./loading.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardPayload, normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  invalidateWorkboardLoads,
  resetWorkboardLifecycleTaskConfirmations,
  setWorkboardLifecycleTaskRefreshFailed,
  workboardHasActiveWrites,
  workboardMutationsReady,
  type WorkboardHost,
} from "./runtime.ts";
import { applyTaskSummariesToState, listWorkboardTasks } from "./task-links.ts";
import type { WorkboardDispatchSummary, WorkboardStatus } from "./types.ts";

function normalizeDispatchSummary(value: unknown): WorkboardDispatchSummary {
  const countArray = (key: string) =>
    isRecord(value) && Array.isArray(value[key]) ? value[key].length : 0;
  return {
    started: countArray("started"),
    failures: countArray("startFailures"),
    promoted: countArray("promoted"),
    blocked: countArray("blocked"),
    reclaimed: countArray("reclaimed"),
    orchestrated: countArray("orchestrated"),
  };
}

export async function saveWorkboardCardDraft(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const cardId = state.editingCardId;
  const base = cardId ? state.editingCardBase : null;
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    !state.draftTitle.trim() ||
    state.dispatching ||
    state.draftSaving ||
    (cardId && state.busyCardIds.has(cardId))
  ) {
    return;
  }
  if (cardId && (!base || base.id !== cardId)) {
    state.error = "This card changed before editing began. Cancel and reopen it to continue.";
    params.requestUpdate?.();
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.draftSaving = true;
  state.loading = true;
  state.error = null;
  params.requestUpdate?.();
  try {
    let payload: unknown;
    if (base) {
      const patch = changedDraftPayload(state);
      if (Object.keys(patch).length === 0) {
        resetDraftState(state);
        return;
      }
      payload = await params.client.request("workboard.cards.update", {
        id: cardId,
        expectedUpdatedAt: base.updatedAt,
        patch,
      });
    } else {
      payload = await params.client.request("workboard.cards.create", {
        ...draftPayload(state),
        ...selectedWorkboardBoardParams(state),
      });
    }
    replaceCard(state, normalizeCardPayload(payload));
    resetDraftState(state);
  } catch (error) {
    if (
      base &&
      isGatewayRequestError(error) &&
      error.code === "workboard_conflict" &&
      isRecord(error.details) &&
      error.details.type === "workboard_card_conflict"
    ) {
      const current = normalizeCardPayload(error.details);
      replaceCard(state, current);
      rebaseWorkboardDraft(state, current);
      state.error = `${error.message} Your unsaved edits remain in the form.`;
    } else {
      state.error = formatError(error);
    }
  } finally {
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function addWorkboardCardComment(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId?: string;
  body?: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  const cardId = params.cardId ?? state.editingCardId;
  const draftField = params.body === undefined ? "draftCommentBody" : "detailCommentBody";
  const submittedDraft = params.body ?? state.draftCommentBody;
  const body = submittedDraft.trim();
  if (
    !cardId ||
    !params.client ||
    !workboardMutationsReady(state) ||
    !body ||
    state.dispatching ||
    state.draftSaving ||
    state.busyCardIds.has(cardId)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.comment", {
      id: cardId,
      body,
    });
    const current = normalizeCardPayload(payload);
    replaceCard(state, current);
    if (state.editingCardId === cardId && state.editingCardBase?.id === cardId) {
      rebaseWorkboardDraft(state, current);
    }
    // The operator may type another note or switch cards while this request settles.
    // Clear only the draft that submitted it, preserving the raw text for comparison.
    const draftCardId =
      draftField === "draftCommentBody" ? state.editingCardId : state.detailCardId;
    if (draftCardId === cardId && state[draftField] === submittedDraft) {
      state[draftField] = "";
    }
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.busyCardIds.delete(cardId);
    params.requestUpdate?.();
  }
}

export async function moveWorkboardCard(
  params: {
    host: WorkboardHost;
    client: GatewayBrowserClient | null;
    cardId: string;
    status: WorkboardStatus;
    requestUpdate?: () => void;
  } & (
    | { position: number; beforeCardId?: never }
    | { beforeCardId: string | null; boardFilter: string; position?: never }
  ),
) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return;
  }
  const card = state.cards.find((candidate) => candidate.id === params.cardId);
  const moves =
    params.beforeCardId === undefined
      ? [{ id: params.cardId, status: params.status, position: params.position }]
      : card
        ? planWorkboardCardDrop(
            state.cards,
            card,
            params.status,
            params.beforeCardId,
            params.boardFilter,
          )
        : [];
  if (!moves.length || moves.some((move) => state.busyCardIds.has(move.id))) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  for (const move of moves) {
    state.busyCardIds.add(move.id);
  }
  state.error = null;
  // A recovered older load must not clear an error owned by this move.
  delete getWorkboardRuntime(params.host).loadError;
  params.requestUpdate?.();
  let reloadAfterFailure = false;
  try {
    for (const move of moves) {
      const payload = await params.client.request("workboard.cards.move", move);
      replaceCard(state, normalizeCardPayload(payload));
    }
  } catch (error) {
    state.error = formatError(error);
    if (moves.length > 1) {
      // Peer moves commit separately; a lost acknowledgment can leave local order stale.
      state.mutationReadiness = "canonical_reload_required";
      state.loaded = false;
      state.loadAttempted = false;
      reloadAfterFailure = true;
    }
  } finally {
    for (const move of moves) {
      state.busyCardIds.delete(move.id);
    }
    if (state.draggedCardId === params.cardId) {
      state.draggedCardId = null;
    }
    params.requestUpdate?.();
  }
  if (reloadAfterFailure) {
    await loadWorkboard({
      host: params.host,
      client: params.client,
      requestUpdate: params.requestUpdate,
      force: true,
      preserveError: true,
      taskRefresh: "linked",
    });
  }
}

export async function deleteWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return false;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    await params.client.request("workboard.cards.delete", { id: params.cardId });
    setWorkboardCards(state, removeCardAndReferences(state.cards, params.cardId));
    return true;
  } catch (error) {
    state.error = formatError(error);
    return false;
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function archiveWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  archived?: boolean;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.cardId)
  ) {
    return false;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.cardId);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.archive", {
      id: params.cardId,
      archived: params.archived ?? true,
    });
    replaceCard(state, normalizeCardPayload(payload));
    return true;
  } catch (error) {
    state.error = formatError(error);
    return false;
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function dispatchWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    workboardHasActiveWrites(state)
  ) {
    return;
  }
  invalidateWorkboardLoads(params.host);
  state.dispatching = true;
  state.error = null;
  state.lastDispatchSummary = null;
  params.requestUpdate?.();
  try {
    const dispatchResult = await params.client.request(
      "workboard.cards.dispatch",
      selectedWorkboardBoardParams(state),
    );
    const payload = await params.client.request("workboard.cards.list", {});
    const normalized = normalizeCardsPayload(payload);
    setWorkboardCards(state, normalized.cards);
    state.statuses = normalized.statuses;
    state.lastDispatchSummary = normalizeDispatchSummary(dispatchResult);
    state.tasksByCardId = new Map();
    resetWorkboardLifecycleTaskConfirmations(state, { host: params.host });
    try {
      applyTaskSummariesToState(state, await listWorkboardTasks(params.client));
      setWorkboardLifecycleTaskRefreshFailed(state, false, { host: params.host });
      state.lifecycleTaskRefreshError = null;
      state.lastRefreshError = null;
    } catch (error) {
      setWorkboardLifecycleTaskRefreshFailed(state, true, {
        host: params.host,
        requestUpdate: params.requestUpdate,
      });
      state.lastRefreshError = formatError(error);
    }
    // A teardown may have invalidated this in-flight dispatch. Keep its cached
    // result reload-required so reconnect cannot treat an old completion as canonical.
    state.loaded = workboardMutationsReady(state);
  } catch (error) {
    state.error = formatError(error);
  } finally {
    state.dispatching = false;
    params.requestUpdate?.();
  }
}
