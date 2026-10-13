import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { WORKBOARD_DRAFT_DEFAULTS } from "./card-state.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import { WORKBOARD_STATUSES, type WorkboardUiState } from "./types.ts";

export type WorkboardHost = object;

export type WorkboardClientContext = {
  host: WorkboardHost;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
};

type WorkboardLiveRefreshEntry = {
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  refresh?: () => Promise<boolean>;
  shouldDefer?: () => boolean;
};

type WorkboardRuntime = {
  state?: WorkboardUiState;
  cardsRevision?: WorkboardChange | null;
  loadPromise?: Promise<boolean>;
  loadClient?: GatewayBrowserClient;
  loadCatalogOnly?: boolean;
  loadError?: string;
  liveChangeEpoch?: string;
  liveHighestSeenRevision?: number;
  liveAppliedRevision?: number;
  liveRefreshPending?: boolean;
  liveRefreshPromise?: Promise<void>;
  liveRefreshRetryTimer?: ReturnType<typeof setTimeout>;
  liveRefreshEntry?: WorkboardLiveRefreshEntry;
};

const workboardRuntimes = new WeakMap<WorkboardHost, WorkboardRuntime>();
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
  delete runtime.cardsRevision;
  delete runtime.loadPromise;
  delete runtime.loadClient;
  delete runtime.loadCatalogOnly;
}

export function stopWorkboardLiveRefresh(host: WorkboardHost): void {
  const runtime = getWorkboardRuntime(host);
  const loadInFlight = Boolean(runtime.loadPromise);
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
  invalidateWorkboardLoads(host);
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
    lastRefreshError: null,
    ...WORKBOARD_DRAFT_DEFAULTS,
    draftSaving: false,
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
  return Boolean(state.bulkSaving || state.draftSaving || state.busyCardIds.size);
}

export function hasCurrentWorkboardCards(host: WorkboardHost, payload: unknown): boolean {
  const change = normalizeWorkboardChange(payload);
  const held = getWorkboardRuntime(host).cardsRevision;
  return Boolean(
    change && held && change.epoch === held.epoch && change.cardsRevision === held.revision,
  );
}
