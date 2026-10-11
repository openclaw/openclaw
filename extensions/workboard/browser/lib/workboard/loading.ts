import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { setWorkboardCards } from "./card-state.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  workboardHasActiveWrites,
  type WorkboardClientContext,
} from "./runtime.ts";
import type { WorkboardRefreshSource, WorkboardUiState } from "./types.ts";

type LoadWorkboardParams = WorkboardClientContext & {
  force?: boolean;
  refreshDiagnostics?: boolean;
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  return await loadWorkboardInternal(params);
}

export async function loadWorkboardCatalog(params: WorkboardClientContext): Promise<boolean> {
  return await loadWorkboardInternal({ ...params, force: true }, true);
}

async function loadWorkboardInternal(
  params: LoadWorkboardParams,
  catalogOnly = false,
): Promise<boolean> {
  const runtime = getWorkboardRuntime(params.host);
  const state = getWorkboardState(params.host);
  if (
    !params.client ||
    state.dispatching ||
    workboardHasActiveWrites(state) ||
    (!params.force && (state.loaded || state.loadAttempted))
  ) {
    return false;
  }
  const client = params.client;
  const existingLoad = runtime.loadPromise;
  if (existingLoad) {
    const requiresTaskLoad = !catalogOnly && runtime.loadCatalogOnly;
    const result = await existingLoad;
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return (params.force || requiresTaskLoad) &&
      runtime.loadClient === client &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboardInternal(params, catalogOnly)
      : result;
  }
  runtime.loadCatalogOnly = catalogOnly;
  runtime.loadClient = client;
  if (!catalogOnly) {
    state.loadAttempted = true;
    state.loading = true;
    if (!params.preserveError) {
      delete runtime.loadError;
      state.error = null;
    }
    state.lastRefreshError = null;
    params.requestUpdate?.();
  }
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
        runtime.cardsRevision ? { sinceRevision: runtime.cardsRevision } : {},
      );
      if (runtime.loadPromise !== loadPromise) {
        return false;
      }
      const unchanged = isRecord(payload) && payload.unchanged === true;
      if (
        catalogOnly &&
        !unchanged &&
        (!isRecord(payload) || !Array.isArray(payload.cards) || !Array.isArray(payload.boards))
      ) {
        return false;
      }
      const normalized = unchanged ? state : normalizeCardsPayload(payload);
      if (catalogOnly) {
        state.boards = normalized.boards;
      }
      // Keep navigation current without replacing cards beneath an unfinished draft.
      if ((catalogOnly || params.preserveError) && shouldDeferWorkboardLiveRefresh(state)) {
        return catalogOnly;
      }
      runtime.cardsRevision = normalizeWorkboardChange(isRecord(payload) ? payload.revision : null);
      setWorkboardCards(state, normalized.cards);
      state.boards = normalized.boards;
      state.statuses = normalized.statuses;
      // Catalog hydration never authorizes stale edits.
      if (catalogOnly) {
        return true;
      }
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
      if (!catalogOnly && runtime.loadPromise === loadPromise) {
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
        if (!catalogOnly && !state.draftSaving) {
          state.loading = false;
        }
        delete runtime.loadPromise;
        delete runtime.loadCatalogOnly;
      }
      params.requestUpdate?.();
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
  params.requestUpdate?.();
  if (!params.client) {
    state.lastRefreshError = "Gateway client unavailable";
    params.requestUpdate?.();
    return false;
  }
  const refreshed = await loadWorkboard({
    host: params.host,
    client: params.client,
    requestUpdate: params.requestUpdate,
    force: true,
    refreshDiagnostics: params.refreshDiagnostics,
    preserveError: passive,
  });
  if (!passive && state.error) {
    state.lastRefreshError = state.error;
  } else if (refreshed) {
    state.lastRefreshAt = Date.now();
  }
  params.requestUpdate?.();
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
