import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isGatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import {
  changedDraftPayload,
  applyPendingCardRemovals,
  applyReferenceUpdatesToPendingCardRemovals,
  captureCardRemoval,
  discardPendingLinksToCard,
  draftPayload,
  planWorkboardCardDrop,
  rebaseWorkboardDraft,
  removeCardAndReferences,
  replaceCard,
  restoreCardRemoval,
  resetDraftState,
  selectedWorkboardBoardParams,
  setWorkboardCards,
  isActiveWorkboardCard,
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
import type {
  WorkboardBulkDialog,
  WorkboardCard,
  WorkboardDeleteResult,
  WorkboardDispatchSummary,
  WorkboardStatus,
  WorkboardUiState,
} from "./types.ts";

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

function cloneBulkDialog(dialog: WorkboardBulkDialog | null): WorkboardBulkDialog | null {
  return dialog
    ? { ...dialog, cardIds: [...dialog.cardIds], observedCards: [...dialog.observedCards] }
    : null;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id));
}

type DeleteInteractionState = {
  selectionScope: Set<string>;
  selectedCardIds: Set<string>;
  bulkDialog: WorkboardBulkDialog | null;
  pendingCardIds: Set<string>;
  userChanged: boolean;
};

const deleteInteractions = new WeakMap<WorkboardUiState, DeleteInteractionState>();

function projectDeleteSelection(
  state: WorkboardUiState,
  interaction: DeleteInteractionState,
): Set<string> {
  const selectableIds = new Set(state.cards.filter(isActiveWorkboardCard).map((card) => card.id));
  return new Set(
    [...interaction.selectedCardIds].filter(
      (cardId) => selectableIds.has(cardId) && !interaction.pendingCardIds.has(cardId),
    ),
  );
}

function projectDeleteBulkDialog(
  state: WorkboardUiState,
  interaction: DeleteInteractionState,
): WorkboardBulkDialog | null {
  const dialog = cloneBulkDialog(interaction.bulkDialog);
  if (!dialog) {
    return null;
  }
  const selectedCardIds = projectDeleteSelection(state, interaction);
  dialog.cardIds = dialog.cardIds.filter(
    (cardId) => selectedCardIds.has(cardId) && !interaction.pendingCardIds.has(cardId),
  );
  dialog.observedCards = state.cards.filter((card) => dialog.cardIds.includes(card.id));
  return dialog.cardIds.length ? dialog : null;
}

function sameBulkDialogProjection(
  left: WorkboardBulkDialog | null,
  right: WorkboardBulkDialog | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.kind === right.kind &&
    left.cardIds.length === right.cardIds.length &&
    left.cardIds.every((id, index) => id === right.cardIds[index]) &&
    (left.kind !== "edit" ||
      (right.kind === "edit" &&
        left.priority === right.priority &&
        left.agentId === right.agentId &&
        left.labels === right.labels &&
        left.labelMode === right.labelMode))
  );
}

function observeDeleteInteraction(
  state: WorkboardUiState,
  interaction: DeleteInteractionState,
): boolean {
  const unchanged =
    !interaction.userChanged &&
    interaction.selectionScope === state.selectedCardIds &&
    sameStringSet(state.selectedCardIds, projectDeleteSelection(state, interaction)) &&
    sameBulkDialogProjection(state.bulkDialog, projectDeleteBulkDialog(state, interaction));
  if (!unchanged) {
    interaction.userChanged = true;
  }
  return unchanged;
}

function beginDeleteInteraction(state: WorkboardUiState, cardId: string): DeleteInteractionState {
  let interaction = deleteInteractions.get(state);
  if (!interaction) {
    interaction = {
      selectionScope: state.selectedCardIds,
      selectedCardIds: new Set(state.selectedCardIds),
      bulkDialog: cloneBulkDialog(state.bulkDialog),
      pendingCardIds: new Set(),
      userChanged: false,
    };
    deleteInteractions.set(state, interaction);
  } else {
    observeDeleteInteraction(state, interaction);
  }
  interaction.pendingCardIds.add(cardId);
  return interaction;
}

function restoreDeleteInteraction(state: WorkboardUiState, interaction: DeleteInteractionState) {
  const selectedCardIds = projectDeleteSelection(state, interaction);
  state.selectedCardIds.clear();
  for (const cardId of selectedCardIds) {
    state.selectedCardIds.add(cardId);
  }
  state.bulkDialog = projectDeleteBulkDialog(state, interaction);
}

function completeDeleteInteraction(state: WorkboardUiState, cardId: string) {
  const interaction = deleteInteractions.get(state);
  if (!interaction) {
    return;
  }
  observeDeleteInteraction(state, interaction);
  interaction.pendingCardIds.delete(cardId);
  interaction.selectedCardIds.delete(cardId);
  if (interaction.bulkDialog) {
    interaction.bulkDialog.cardIds = interaction.bulkDialog.cardIds.filter(
      (pendingCardId) => pendingCardId !== cardId,
    );
    interaction.bulkDialog.observedCards = interaction.bulkDialog.observedCards.filter(
      (card) => card.id !== cardId,
    );
    if (!interaction.bulkDialog.cardIds.length) {
      interaction.bulkDialog = null;
    }
  }
  if (!interaction.pendingCardIds.size) {
    deleteInteractions.delete(state);
  }
}

function rejectDeleteInteraction(state: WorkboardUiState, cardId: string) {
  const interaction = deleteInteractions.get(state);
  if (!interaction) {
    return;
  }
  const unchanged = observeDeleteInteraction(state, interaction);
  interaction.pendingCardIds.delete(cardId);
  if (unchanged) {
    restoreDeleteInteraction(state, interaction);
  }
  if (!interaction.pendingCardIds.size) {
    deleteInteractions.delete(state);
  }
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
    if (
      draftField === "detailCommentBody" &&
      state.detailCommentDrafts.get(cardId) === submittedDraft
    ) {
      state.detailCommentDrafts.delete(cardId);
    }
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

function reconcileCardConflict(
  state: ReturnType<typeof getWorkboardState>,
  error: unknown,
): boolean {
  if (
    isGatewayRequestError(error) &&
    error.code === "workboard_conflict" &&
    isRecord(error.details) &&
    error.details.type === "workboard_card_conflict"
  ) {
    replaceCard(state, normalizeCardPayload(error.details));
    return true;
  }
  return false;
}

export async function moveWorkboardCard(
  params: {
    host: WorkboardHost;
    client: GatewayBrowserClient | null;
    cardId: string;
    status: WorkboardStatus;
    expectedUpdatedAt?: number;
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
      const payload =
        "expectedUpdatedAt" in move
          ? await params.client.request("workboard.cards.update", {
              id: move.id,
              expectedUpdatedAt: move.expectedUpdatedAt,
              patch: { position: move.position },
            })
          : await params.client.request("workboard.cards.move", {
              ...move,
              ...(params.expectedUpdatedAt !== undefined && move.id === params.cardId
                ? { expectedUpdatedAt: params.expectedUpdatedAt }
                : {}),
            });
      replaceCard(state, normalizeCardPayload(payload));
    }
  } catch (error) {
    state.error = formatError(error);
    if (!reconcileCardConflict(state, error)) {
      // Even a single move can commit before its acknowledgment is lost.
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
      taskRefresh: "all",
    });
  }
}

export async function updateWorkboardCardProperties(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  card: WorkboardCard;
  patch: Partial<Pick<WorkboardCard, "priority" | "labels" | "agentId" | "title" | "notes">>;
  requestUpdate?: () => void;
}) {
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    !workboardMutationsReady(state) ||
    state.dispatching ||
    state.busyCardIds.has(params.card.id)
  ) {
    return false;
  }
  invalidateWorkboardLoads(params.host);
  state.busyCardIds.add(params.card.id);
  state.error = null;
  params.requestUpdate?.();
  try {
    const payload = await params.client.request("workboard.cards.update", {
      id: params.card.id,
      expectedUpdatedAt: params.card.updatedAt,
      patch: params.patch,
    });
    replaceCard(state, normalizeCardPayload(payload));
    return true;
  } catch (error) {
    reconcileCardConflict(state, error);
    state.error = formatError(error);
    return false;
  } finally {
    state.busyCardIds.delete(params.card.id);
    params.requestUpdate?.();
  }
}

export async function deleteWorkboardCard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  cardId: string;
  expectedUpdatedAt?: number;
  requestUpdate?: () => void;
}): Promise<WorkboardDeleteResult | false> {
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
  beginDeleteInteraction(state, params.cardId);
  const removal = captureCardRemoval(state.cards, params.cardId, state.pendingCardRemovals);
  state.pendingCardRemovals.set(params.cardId, removal);
  setWorkboardCards(state, applyPendingCardRemovals(state.cards, state.pendingCardRemovals));
  params.requestUpdate?.();
  try {
    const result = await params.client.request<WorkboardDeleteResult>("workboard.cards.delete", {
      id: params.cardId,
      ...(params.expectedUpdatedAt !== undefined
        ? { expectedUpdatedAt: params.expectedUpdatedAt }
        : {}),
    });
    const referenceUpdates = new Map(
      (result.referenceUpdates ?? []).map((receipt) => [receipt.id, receipt]),
    );
    applyReferenceUpdatesToPendingCardRemovals(
      state.pendingCardRemovals,
      result.referenceUpdates ?? [],
    );
    const remaining = removeCardAndReferences(state.cards, params.cardId);
    for (const [index, card] of remaining.entries()) {
      const receipt = referenceUpdates.get(card.id);
      if (receipt && card.updatedAt === receipt.previousUpdatedAt) {
        remaining[index] = { ...card, updatedAt: receipt.updatedAt };
      }
    }
    // Invalidate any list read that overlapped the delete before removing the
    // tombstone, so an older payload cannot resurrect the acknowledged card.
    invalidateWorkboardLoads(params.host);
    state.pendingCardRemovals.delete(params.cardId);
    discardPendingLinksToCard(state.pendingCardRemovals, params.cardId);
    setWorkboardCards(state, applyPendingCardRemovals(remaining, state.pendingCardRemovals));
    completeDeleteInteraction(state, params.cardId);
    return result;
  } catch (error) {
    const rollback = state.pendingCardRemovals.get(params.cardId) ?? removal;
    state.pendingCardRemovals.delete(params.cardId);
    setWorkboardCards(
      state,
      applyPendingCardRemovals(
        restoreCardRemoval(state.cards, rollback, state.pendingCardRemovals),
        state.pendingCardRemovals,
      ),
    );
    reconcileCardConflict(state, error);
    setWorkboardCards(state, applyPendingCardRemovals(state.cards, state.pendingCardRemovals));
    rejectDeleteInteraction(state, params.cardId);
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
  expectedUpdatedAt?: number;
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
      ...(params.expectedUpdatedAt !== undefined
        ? { expectedUpdatedAt: params.expectedUpdatedAt }
        : {}),
    });
    replaceCard(state, normalizeCardPayload(payload));
    return true;
  } catch (error) {
    reconcileCardConflict(state, error);
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
  state.bulkResult = null;
  params.requestUpdate?.();
  try {
    const dispatchResult = await params.client.request(
      "workboard.cards.dispatch",
      selectedWorkboardBoardParams(state),
    );
    const payload = await params.client.request("workboard.cards.list", {});
    const normalized = normalizeCardsPayload(payload);
    setWorkboardCards(state, applyPendingCardRemovals(normalized.cards, state.pendingCardRemovals));
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
