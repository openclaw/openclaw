import type { FeatureClient } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import type { KnowledgeLocation } from "./page-location.js";
import type { PageState, RecentCursor } from "./page-state.js";
import type { TemporalSelection } from "./search-date-filters.js";

/** Everything a Knowledge page view needs from its mount: state, shared
 * elements, and the navigation and loading entry points it may call. */
export type Page = {
  s: PageState;
  /** Store settings and the viewing selector. */
  base: FeatureClient<typeof contract>;
  /** Reads as the selected agent's effective store. */
  feature: FeatureClient<typeof contract>;
  root: HTMLElement;
  content: HTMLElement;
  loading: HTMLElement;
  status: HTMLElement;
  banner: HTMLElement;
  announcer: HTMLElement;
  updates: HTMLButtonElement;
  browseTab: HTMLButtonElement;
  scribesTab: HTMLButtonElement;
  recentBack: RecentCursor[];
  recentExpanded: Set<number | string>;
  evidenceLoaders: WeakMap<HTMLDetailsElement, () => Promise<void>>;
  live: (n: number) => boolean;
  errorText: (error: unknown) => string;
  failure: (error: unknown) => HTMLParagraphElement;
  empty: (heading: string, text: string) => HTMLDivElement;
  agentName: (id?: string) => string | undefined;
  askLabel: () => string;
  searchPlaceholder: () => string;
  displayName: (id: string) => string;
  viewedAgent: () => string;
  announce: (text: string) => void;
  viewKey: () => string;
  open: (id: string) => void;
  load: (background?: boolean) => Promise<boolean>;
  refresh: (replaceLocation?: boolean) => Promise<void>;
  renderToolbar: () => void;
  renderStoreContext: () => void;
  navigate: (next: KnowledgeLocation["tab"]) => void;
  openSettings: (section: KnowledgeLocation["section"]) => void;
  writeLocation: (replace?: boolean) => void;
  temporalSelection: () => TemporalSelection;
};
