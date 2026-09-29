import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { setWorkboardCards } from "./card-state.ts";
import { formatError } from "./normalization-utils.ts";
import { normalizeCardsPayload } from "./normalization.ts";
import {
  getWorkboardRuntime,
  getWorkboardState,
  isCurrentWorkboardLoadGeneration,
  nextWorkboardLoadGeneration,
  workboardHasActiveWrites,
  type WorkboardHost,
  type WorkboardLoadToken,
} from "./runtime.ts";
import type { WorkboardRefreshSource, WorkboardUiState } from "./types.ts";

type LoadWorkboardParams = {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  force?: boolean;
  refreshDiagnostics?: boolean;
  preserveError?: boolean;
};

export async function loadWorkboard(params: LoadWorkboardParams): Promise<boolean> {
  return await loadWorkboardInternal(params);
}

export async function loadWorkboardCatalog(
  params: Pick<LoadWorkboardParams, "host" | "client" | "requestUpdate">,
): Promise<boolean> {
  return await loadWorkboardInternal({ ...params, force: true }, undefined, true);
}

async function loadWorkboardInternal(
  params: LoadWorkboardParams,
  queuedAfterGeneration?: number,
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
    const existingGeneration = runtime.loadGeneration;
    const requiresTaskLoad = !catalogOnly && runtime.loadToken?.catalogOnly;
    const result = await existingLoad;
    const existingLoadIsCurrent =
      existingGeneration !== undefined &&
      isCurrentWorkboardLoadGeneration(params.host, existingGeneration);
    const currentLoadMarker = runtime.loadToken;
    // Only follow a replacement created by this load's forced-waiter queue.
    // Fresh loads after teardown or writes must not revive stale callers.
    const queuedLoadReplacedExisting =
      existingGeneration !== undefined &&
      currentLoadMarker?.queuedAfterGeneration === existingGeneration &&
      Boolean(runtime.loadPromise);
    // Forced callers carry their own diagnostics/task-refresh contract, so a
    // weaker in-flight load cannot satisfy them.
    return (params.force || requiresTaskLoad) &&
      (existingLoadIsCurrent || queuedLoadReplacedExisting) &&
      !state.dispatching &&
      !workboardHasActiveWrites(state)
      ? await loadWorkboardInternal(params, existingGeneration, catalogOnly)
      : result;
  }
  const generation = nextWorkboardLoadGeneration(params.host);
  const loadToken: WorkboardLoadToken = { queuedAfterGeneration, catalogOnly };
  runtime.loadToken = loadToken;
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
  const loadPromise = (async () => {
    try {
      if (params.refreshDiagnostics) {
        try {
          await client.request("workboard.cards.diagnostics.refresh", {});
        } catch (error) {
          if (isCurrentWorkboardLoadGeneration(params.host, generation)) {
            state.lastRefreshError = formatError(error);
          }
        }
      }
      const payload = await client.request("workboard.cards.list", {});
      if (
        catalogOnly &&
        (!isRecord(payload) || !Array.isArray(payload.cards) || !Array.isArray(payload.boards))
      ) {
        return false;
      }
      const normalized = normalizeCardsPayload(payload);
      if (!isCurrentWorkboardLoadGeneration(params.host, generation)) {
        return false;
      }
      if (catalogOnly) {
        state.boards = normalized.boards;
        // Keep navigation current without replacing cards beneath an unfinished draft.
        if (shouldDeferWorkboardLiveRefresh(state)) {
          return true;
        }
        // Catalog hydration never establishes task freshness or authorizes stale edits.
        setWorkboardCards(state, normalized.cards);
        state.statuses = normalized.statuses;
        return true;
      }
      if (params.preserveError && shouldDeferWorkboardLiveRefresh(state)) {
        return false;
      }
      setWorkboardCards(state, normalized.cards);
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
      if (!catalogOnly && isCurrentWorkboardLoadGeneration(params.host, generation)) {
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
      const isCurrentGeneration = isCurrentWorkboardLoadGeneration(params.host, generation);
      const ownsLoad = runtime.loadToken === loadToken;
      if (!catalogOnly && !isCurrentGeneration && !state.loaded) {
        state.loadAttempted = false;
      }
      if (!catalogOnly && (isCurrentGeneration || (ownsLoad && !state.draftSaving))) {
        state.loading = false;
      }
      if (ownsLoad) {
        delete runtime.loadPromise;
        delete runtime.loadToken;
      }
      params.requestUpdate?.();
    }
  })();
  runtime.loadPromise = loadPromise;
  return await loadPromise;
}

export async function refreshWorkboard(params: {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  source: WorkboardRefreshSource;
  refreshDiagnostics?: boolean;
}): Promise<boolean> {
  const state = getWorkboardState(params.host);
  const passive = params.source === "live";
  if (state.dispatching || workboardHasActiveWrites(state)) {
    return false;
  }
  const startedAt = Date.now();
  state.lastRefreshStartedAt = startedAt;
  state.lastRefreshSource = params.source;
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
  state.lastRefreshSource = params.source;
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
