import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { setWorkboardCards } from "./card-state.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  notifyWorkboard,
  workboardHasActiveWrites,
  type WorkboardClientContext,
} from "./runtime.ts";
import type { WorkboardRefreshSource, WorkboardUiState } from "./types.ts";

type LoadWorkboardParams = WorkboardClientContext & {
  force?: boolean;
  more?: boolean;
  refreshDiagnostics?: boolean;
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  const runtime = getWorkboardRuntime(params.host);
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    (params.more && !state.nextCursor) ||
    (!params.force && !params.more && (state.loaded || state.loadAttempted))
  ) {
    return false;
  }
  const client = params.client;
  const existingLoad = runtime.loadPromise;
  if (existingLoad) {
    const result = await existingLoad;
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return params.force &&
      runtime.loadClient === client &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboard(params)
      : result;
  }
  runtime.loadClient = client;
  state.loadAttempted = true;
  state.loading = true;
  if (!params.preserveError) {
    delete runtime.loadError;
    state.error = null;
  }
  state.lastRefreshError = null;
  notifyWorkboard(params.host);
  const loadPromise: Promise<boolean> = Promise.resolve().then(async () => {
    try {
      if (params.refreshDiagnostics) {
        try {
          await client.request("workboard.cards.diagnostics.refresh", {});
        } catch (error) {
          if (runtime.loadPromise === loadPromise) {
            state.lastRefreshError = formatError(error);
          }
        }
      }
      const payload = await client.request(
        "workboard.cards.list",
        params.more
          ? { after: state.nextCursor }
          : runtime.cardsRevision
            ? { sinceRevision: runtime.cardsRevision }
            : {},
      );
      if (runtime.loadPromise !== loadPromise) {
        return false;
      }
      const unchanged = isRecord(payload) && payload.unchanged === true;
      const normalized = unchanged ? state : normalizeCardsPayload(payload);
      if (!unchanged && !params.more) {
        // Refresh the held window through bounded pages; do not collapse a reader
        // back to the first page after every live write.
        while (normalized.nextCursor && normalized.cards.length < state.cards.length) {
          const page = normalizeCardsPayload(
            await client.request("workboard.cards.list", { after: normalized.nextCursor }),
          );
          if (runtime.loadPromise !== loadPromise) {
            return false;
          }
          normalized.cards.push(...page.cards);
          normalized.nextCursor = page.nextCursor;
        }
      }
      if (params.preserveError && shouldDeferWorkboardLiveRefresh(state)) {
        return false;
      }
      if (!params.more) {
        runtime.cardsRevision = normalizeWorkboardChange(
          isRecord(payload) ? payload.revision : null,
        );
      }
      setWorkboardCards(
        state,
        params.more
          ? [
              ...new Map(
                [...state.cards, ...normalized.cards].map((card) => [card.id, card]),
              ).values(),
            ]
          : normalized.cards,
      );
      state.nextCursor = normalized.nextCursor;
      state.boards = normalized.boards;
      state.statuses = normalized.statuses;
      const recoveredLoadError = runtime.loadError;
      if (recoveredLoadError !== undefined && state.error === recoveredLoadError) {
        state.error = null;
      }
      delete runtime.loadError;
      // Preserve stale edit text for recovery, but never re-enable its full-card
      // save payload after canonical state may have changed.
      state.mutationReadiness = state.editingCardId ? "stale_edit_draft" : "ready";
      state.loaded = true;
      return true;
    } catch (error) {
      if (runtime.loadPromise === loadPromise) {
        const formattedError = formatError(error);
        if (params.preserveError) {
          state.lastRefreshError = formattedError;
        } else {
          runtime.loadError = formattedError;
          state.error = formattedError;
        }
      }
      return false;
    } finally {
      if (runtime.loadPromise === loadPromise) {
        if (!state.draftSaving) {
          state.loading = false;
        }
        delete runtime.loadPromise;
      }
      notifyWorkboard(params.host);
    }
  });
  runtime.loadPromise = loadPromise;
  return await loadPromise;
}

export async function refreshWorkboard(
  params: WorkboardClientContext & {
    source: WorkboardRefreshSource;
    refreshDiagnostics?: boolean;
  },
): Promise<boolean> {
  const state = getWorkboardState(params.host);
  const passive = params.source === "live";
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return false;
  }
  state.lastRefreshError = null;
  notifyWorkboard(params.host);
  if (!params.client) {
    state.lastRefreshError = "Gateway client unavailable";
    notifyWorkboard(params.host);
    return false;
  }
  const refreshed = await loadWorkboard({
    host: params.host,
    client: params.client,
    force: true,
    refreshDiagnostics: params.refreshDiagnostics,
    preserveError: passive,
  });
  if (!passive && state.error) {
    state.lastRefreshError = state.error;
  } else if (refreshed) {
    state.lastRefreshAt = Date.now();
  }
  notifyWorkboard(params.host);
  return refreshed;
}

export function shouldDeferWorkboardLiveRefresh(state: WorkboardUiState): boolean {
  return Boolean(
    state.draftOpen ||
    state.editingCardId ||
    workboardHasActiveWrites(state) ||
    state.draggedCardId ||
    state.dispatching ||
    state.detailCommentBody.trim() ||
    state.draftCommentBody.trim(),
  );
}
