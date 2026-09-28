import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { WORKBOARD_STATUSES, type WorkboardUiState } from "./types.ts";

export type WorkboardHost = object;

export type WorkboardLoadToken = {
  queuedAfterGeneration?: number;
  catalogOnly: boolean;
};

type WorkboardLiveRefreshEntry = {
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
};

type WorkboardRuntime = {
  state?: WorkboardUiState;
  loadPromise?: Promise<boolean>;
  loadToken?: WorkboardLoadToken;
  loadError?: string;
  loadGeneration?: number;
  liveRefreshGeneration?: number;
  liveChangeEpoch?: string;
  liveHighestSeenRevision?: number;
  liveAppliedRevision?: number;
  liveRefreshPending?: boolean;
  liveRefreshPromise?: Promise<void>;
  liveRefreshRetryTimer?: ReturnType<typeof setTimeout>;
  liveRefreshEntry?: WorkboardLiveRefreshEntry;
};

const workboardRuntimes = new WeakMap<WorkboardHost, WorkboardRuntime>();
export function nextWorkboardLoadGeneration(host: WorkboardHost): number {
  const runtime = getWorkboardRuntime(host);
  const generation = (runtime.loadGeneration ?? 0) + 1;
  runtime.loadGeneration = generation;
  return generation;
}

export function isCurrentWorkboardLoadGeneration(host: WorkboardHost, generation: number): boolean {
  return getWorkboardRuntime(host).loadGeneration === generation;
}

export function invalidateWorkboardLoads(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const state = runtime.state;
  if (state) {
    if (runtime.loadPromise) {
      if (!state.draftSaving) {
        state.loading = false;
      }
      if (!state.loaded) {
        state.loadAttempted = false;
      }
    }
  }
  nextWorkboardLoadGeneration(host);
  delete runtime.loadPromise;
  delete runtime.loadToken;
}

export function stopWorkboardLiveRefresh(host: WorkboardHost): void {
  const runtime = getWorkboardRuntime(host);
  const loadInFlight = Boolean(runtime.loadPromise);
  runtime.liveRefreshGeneration = (runtime.liveRefreshGeneration ?? 0) + 1;
  if (runtime.liveRefreshRetryTimer) {
    clearTimeout(runtime.liveRefreshRetryTimer);
    delete runtime.liveRefreshRetryTimer;
  }
  delete runtime.liveRefreshEntry;
  delete runtime.liveRefreshPromise;
  delete runtime.liveChangeEpoch;
  delete runtime.liveHighestSeenRevision;
  delete runtime.liveAppliedRevision;
  delete runtime.liveRefreshPending;
  if (loadInFlight) {
    invalidateWorkboardLoads(host);
  }
}

export function resetWorkboardConnectionState(host: WorkboardHost) {
  const runtime = getWorkboardRuntime(host);
  const state = runtime.state;
  if (state) {
    // Detach stale loads so reconnecting can start fresh without letting the
    // old request clear a concurrent draft-save loading state.
    if (!state.draftSaving) {
      state.loading = false;
    }
    // Keep cached cards visible across disconnects, but require a canonical
    // reload before accepting writes against data that may now be stale.
    state.mutationReadiness = "canonical_reload_required";
    state.loaded = false;
    state.loadAttempted = false;
  }
  nextWorkboardLoadGeneration(host);
  delete runtime.loadPromise;
  delete runtime.loadToken;
}

function createDefaultState(): WorkboardUiState {
  return {
    loading: false,
    loaded: false,
    loadAttempted: false,
    mutationReadiness: "ready",
    error: null,
    cards: [],
    boards: [],
    statuses: WORKBOARD_STATUSES,
    lastDispatchSummary: null,
    dispatching: false,
    query: "",
    searchOpen: false,
    priorityFilter: new Set(),
    statusFilter: new Set(),
    attentionFilter: new Set(),
    donePeriod: "all",
    agentFilter: "all",
    boardFilter: "__all__",
    showArchived: false,
    layout: "comfortable",
    viewMode: "board",
    emptyColumnMode: "show",
    collapsedStatuses: new Set(),
    expandedEmptyStatuses: new Set(),
    lastRefreshAt: null,
    lastRefreshStartedAt: null,
    lastRefreshError: null,
    lastRefreshSource: null,
    draftOpen: false,
    draftDiscardOpen: false,
    draftSaving: false,
    editingCardId: null,
    editingCardBase: null,
    draftTitle: "",
    draftNotes: "",
    draftStatus: "todo",
    draftPriority: "normal",
    draftLabels: "",
    draftAgentId: "",
    draftSessionKey: "",
    draftTemplateId: "",
    draftCommentBody: "",
    detailCardId: null,
    detailTab: "overview",
    detailCommentBody: "",
    detailCommentDrafts: new Map(),
    busyCardIds: new Set(),
    selectedCardIds: new Set(),
    bulkDialog: null,
    bulkSaving: false,
    bulkResult: null,
    draggedCardId: null,
    dragOverStatus: null,
    dragBeforeCardId: null,
    capturingSessionKeys: new Set(),
  };
}

export function getWorkboardRuntime(host: WorkboardHost): WorkboardRuntime {
  let runtime = workboardRuntimes.get(host);
  if (!runtime) {
    runtime = {};
    workboardRuntimes.set(host, runtime);
  }
  return runtime;
}

export function getWorkboardState(host: WorkboardHost): WorkboardUiState {
  const runtime = getWorkboardRuntime(host);
  runtime.state ??= createDefaultState();
  return runtime.state;
}

export function workboardMutationsReady(state: WorkboardUiState): boolean {
  return state.mutationReadiness === "ready";
}

export function workboardHasActiveWrites(state: WorkboardUiState): boolean {
  return Boolean(
    state.bulkSaving ||
    state.draftSaving ||
    state.busyCardIds.size ||
    state.capturingSessionKeys.size,
  );
}
