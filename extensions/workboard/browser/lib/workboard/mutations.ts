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
  workboardHasActiveWrites,
  workboardMutationsReady,
  type WorkboardClientContext,
} from "./runtime.ts";
import type {
  WorkboardCard,
  WorkboardDeleteResult,
  WorkboardDispatchSummary,
  WorkboardStatus,
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

export async function saveWorkboardCardDraft(params: WorkboardClientContext) {
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
    const conflict = base && reconcileCardConflict(state, error);
    if (conflict) {
      rebaseWorkboardDraft(state, conflict.card);
      state.error = `${conflict.message} Your unsaved edits remain in the form.`;
    } else {
      state.error = formatError(error);
    }
  } finally {
    state.draftSaving = false;
    state.loading = false;
    params.requestUpdate?.();
  }
}

export async function addWorkboardCardComment(
  params: WorkboardClientContext & {
    cardId?: string;
    body?: string;
  },
) {
  const draftState = getWorkboardState(params.host);
  const cardId = params.cardId ?? draftState.editingCardId;
  const draftField = params.body === undefined ? "draftCommentBody" : "detailCommentBody";
  const submittedDraft = params.body ?? draftState.draftCommentBody;
  const body = submittedDraft.trim();
  if (!cardId || !body || draftState.draftSaving) {
    return;
  }
  await runWorkboardCardMutation(
    { ...params, cardId, reconcileConflict: false },
    async (state, client) => {
      const payload = await client.request("workboard.cards.comment", {
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
    },
  );
}

function reconcileCardConflict(state: ReturnType<typeof getWorkboardState>, error: unknown) {
  if (
    isGatewayRequestError(error) &&
    error.code === "workboard_conflict" &&
    isRecord(error.details) &&
    error.details.type === "workboard_card_conflict"
  ) {
    const card = normalizeCardPayload(error.details);
    replaceCard(state, card);
    return { card, message: error.message };
  }
  return null;
}

export async function moveWorkboardCard(
  params: WorkboardClientContext & {
    cardId: string;
    status: WorkboardStatus;
    expectedUpdatedAt?: number;
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
    invalidateWorkboardLoads(params.host);
    await loadWorkboard({
      host: params.host,
      client: params.client,
      requestUpdate: params.requestUpdate,
      force: true,
      preserveError: true,
    });
  }
}

type WorkboardCardMutationParams = WorkboardClientContext & {
  cardId: string;
};

export async function runWorkboardCardMutation<T>(
  params: WorkboardCardMutationParams & { reconcileConflict?: boolean },
  mutate: (state: ReturnType<typeof getWorkboardState>, client: GatewayBrowserClient) => Promise<T>,
): Promise<T | false> {
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
    return await mutate(state, params.client);
  } catch (error) {
    if (params.reconcileConflict !== false) {
      reconcileCardConflict(state, error);
    }
    state.error = formatError(error);
    return false;
  } finally {
    state.busyCardIds.delete(params.cardId);
    params.requestUpdate?.();
  }
}

export async function updateWorkboardCardProperties(
  params: WorkboardClientContext & {
    card: WorkboardCard;
    patch: Partial<Pick<WorkboardCard, "priority" | "labels" | "agentId" | "title" | "notes">>;
  },
) {
  return runWorkboardCardMutation({ ...params, cardId: params.card.id }, async (state, client) => {
    const payload = await client.request("workboard.cards.update", {
      id: params.card.id,
      expectedUpdatedAt: params.card.updatedAt,
      patch: params.patch,
    });
    replaceCard(state, normalizeCardPayload(payload));
    return true;
  });
}

export async function deleteWorkboardCard(
  params: WorkboardCardMutationParams & { expectedUpdatedAt?: number },
): Promise<WorkboardDeleteResult | false> {
  return runWorkboardCardMutation(params, async (state, client) => {
    const result = await client.request<WorkboardDeleteResult>("workboard.cards.delete", {
      id: params.cardId,
      ...(params.expectedUpdatedAt !== undefined
        ? { expectedUpdatedAt: params.expectedUpdatedAt }
        : {}),
    });
    const referenceUpdates = new Map(
      (result.referenceUpdates ?? []).map((receipt) => [receipt.id, receipt]),
    );
    const remaining = removeCardAndReferences(state.cards, params.cardId);
    for (const [index, card] of remaining.entries()) {
      const receipt = referenceUpdates.get(card.id);
      if (receipt && card.updatedAt === receipt.previousUpdatedAt) {
        remaining[index] = { ...card, updatedAt: receipt.updatedAt };
      }
    }
    setWorkboardCards(state, remaining);
    return result;
  });
}

export async function archiveWorkboardCard(
  params: WorkboardCardMutationParams & { archived?: boolean; expectedUpdatedAt?: number },
) {
  return runWorkboardCardMutation(params, async (state, client) => {
    const payload = await client.request("workboard.cards.archive", {
      id: params.cardId,
      archived: params.archived ?? true,
      ...(params.expectedUpdatedAt !== undefined
        ? { expectedUpdatedAt: params.expectedUpdatedAt }
        : {}),
    });
    replaceCard(state, normalizeCardPayload(payload));
    return true;
  });
}

export async function dispatchWorkboard(params: WorkboardClientContext) {
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
    setWorkboardCards(state, normalized.cards);
    state.statuses = normalized.statuses;
    state.lastDispatchSummary = normalizeDispatchSummary(dispatchResult);
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
