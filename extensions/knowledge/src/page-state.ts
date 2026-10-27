import type { ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { loadVocabulary } from "./inspection-client.js";
import { locationKey, type KnowledgeLocation } from "./page-location.js";

type StoresSnapshot = FeatureOutput<typeof contract, "stores_snapshot">;
export type RecentCursor = { upperSequence: number; beforeSequence: number } | undefined;

/** Mutable state of one mounted Knowledge page, shared by its view modules. */
export type PageState = {
  context: ControlUiViewContext;
  viewing: string;
  expectedVault: string;
  settingsSection: KnowledgeLocation["section"];
  storesSnapshot: StoresSnapshot | undefined;
  storeContextSignature: string;
  routeKey: string;
  scopeChecked: boolean;
  scopeMismatch: boolean;
  storeState: FeatureOutput<typeof contract, "status">["store"];
  storeMessage: string | undefined;
  tab: KnowledgeLocation["tab"];
  selectedId: string;
  /** Scribe detail on the Scribes tab; empty for the list. */
  scribe: string;
  query: string;
  kind: KnowledgeLocation["kind"];
  type: string;
  offset: number;
  browseBack: number[];
  recentCursor: RecentCursor;
  includeHistory: boolean;
  browseQuery: string;
  originFilter: string;
  since: string;
  until: string;
  timeField: KnowledgeLocation["timeField"];
  recentSequence: number;
  lastChecked: string;
  pendingSnapshot: string | undefined;
  generation: number;
  statusGeneration: number;
  disposed: boolean;
  identity: string;
  agentId: string;
  searchSnapshot: string | null | undefined;
  displayGeneration: number;
  viewReady: boolean;
  snapshot: string | undefined;
  staging: HTMLElement | undefined;
  loadingGeneration: number;
  displayView: string;
  displayScreen: string;
  mountedScreen: string;
  connectionPages: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  suggestGeneration: number;
  vocabulary: Awaited<ReturnType<typeof loadVocabulary>> | undefined;
  refreshing: boolean;
  refreshAgain: boolean;
  pendingReplaceLocation: boolean;
};

/** Initial page state for a mount opened at `location`. */
export function createPageState(
  context: ControlUiViewContext,
  location: KnowledgeLocation,
): PageState {
  return {
    context,
    viewing: location.agent,
    expectedVault: location.vault,
    settingsSection: location.section,
    storesSnapshot: undefined,
    storeContextSignature: "",
    routeKey: locationKey(location),
    scopeChecked: false,
    scopeMismatch: false,
    storeState: "ready",
    storeMessage: undefined,
    tab: location.tab,
    selectedId: location.record,
    scribe: location.scribe,
    query: location.query,
    kind: location.kind,
    type: location.type,
    offset: location.offset,
    browseBack: location.back,
    recentCursor: location.cursor,
    includeHistory: location.history,
    browseQuery: location.filter,
    originFilter: location.origin,
    since: location.since,
    until: location.until,
    timeField: location.timeField,
    recentSequence: 0,
    lastChecked: "",
    pendingSnapshot: undefined,
    generation: 0,
    statusGeneration: 0,
    disposed: false,
    identity: "",
    agentId: "",
    searchSnapshot: undefined,
    displayGeneration: 0,
    viewReady: false,
    snapshot: undefined,
    staging: undefined,
    loadingGeneration: 0,
    displayView: "",
    displayScreen: "",
    mountedScreen: "",
    connectionPages: 1,
    timer: undefined,
    suggestGeneration: 0,
    vocabulary: undefined,
    refreshing: false,
    refreshAgain: false,
    pendingReplaceLocation: true,
  };
}

// Loading belongs to the destination pane, not the whole application.
export function loadingLabel(s: PageState) {
  return s.selectedId
    ? "Opening record…"
    : "Loading " +
        (s.tab === "browse"
          ? s.kind === "relationship"
            ? "connections"
            : s.kind === "claim"
              ? "claims"
              : "pages"
          : s.tab) +
        "…";
}
