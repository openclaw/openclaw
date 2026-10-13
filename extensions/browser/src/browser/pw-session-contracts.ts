import type {
  Browser,
  BrowserContext,
  CDPSession,
  Dialog,
  Frame,
  Page,
  Request,
} from "playwright-core";
import type { BrowserDownloadCandidate, BrowserDownloadResult } from "./download-types.js";
import type { BrowserEngineId } from "./engines/types.js";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

export type BrowserObservedDialogRecord = {
  id: string;
  type: string;
  message: string;
  defaultValue?: string;
  openedAt: string;
  closedAt?: string;
  closedBy?: "agent" | "armed" | "auto" | "timeout" | "remote";
};

export type BrowserObservedState = {
  dialogs: {
    pending: BrowserObservedDialogRecord[];
    recent: BrowserObservedDialogRecord[];
  };
};

export class BrowserObservedDialogBlockedError extends Error {
  readonly browserState: BrowserObservedState;

  constructor(browserState: BrowserObservedState) {
    super("Browser action blocked by a modal dialog.");
    this.name = "BrowserObservedDialogBlockedError";
    this.browserState = browserState;
  }
}

export function isBrowserObservedDialogBlockedError(
  err: unknown,
): err is BrowserObservedDialogBlockedError {
  return err instanceof BrowserObservedDialogBlockedError;
}

export type PendingObservedDialog = BrowserObservedDialogRecord & {
  dialog: Dialog;
};

export type ArmedDialogResponse = {
  accept: boolean;
  promptText?: string;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  engine?: BrowserEngineId;
  onDisconnected?: () => void;
};

export type ActionDownloadCapture = {
  beforeSave?: (download: BrowserDownloadCandidate) => Promise<void> | void;
  lastEventAtMs?: number;
  pending: Array<Promise<BrowserDownloadResult>>;
  validations: Array<Promise<void>>;
  waiters: Array<() => void>;
};

export type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: Map<string, BrowserNetworkRequest>;
  // Strong Request keys would retain disposed Playwright page/context graphs.
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDownload: number;
  downloadWaiterDepth: number;
  actionDownloadCapture?: ActionDownloadCapture;
  nextObservedDialogId: number;
  pendingDialogs: PendingObservedDialog[];
  recentDialogs: BrowserObservedDialogRecord[];
  armedDialogResponse?: ArmedDialogResponse;
  dialogAbortControllers: Set<AbortController>;
  /** Persistent session and queue for page-scoped emulation overrides. */
  emulation?: {
    session?: Promise<CDPSession>;
    transitionTail?: Promise<void>;
    transitionAbort?: AbortController;
    metricsOwner?: { session: CDPSession; viewport: { width: number; height: number } };
    touch?: { session: CDPSession; enabled: boolean };
  };
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrame?: Frame;
  /** Target-cache entry owned by the current role refs. */
  roleRefsTargetKey?: string;
  /** Navigation observed before target discovery invalidates the eventual cache entry. */
  roleRefsInvalidated?: boolean;
};

export type RoleRefs = NonNullable<PageState["roleRefs"]>;
export type RoleRefsCacheEntry = {
  refs: RoleRefs;
  mode?: NonNullable<PageState["roleRefsMode"]>;
};

export type ContextState = {
  traceActive: boolean;
};

export const pageStates = new WeakMap<Page, PageState>();
export const contextStates = new WeakMap<BrowserContext, ContextState>();
export const observedContexts = new WeakSet<BrowserContext>();

export const MAX_CONSOLE_MESSAGES = 500;
export const MAX_PAGE_ERRORS = 200;
export const MAX_NETWORK_REQUESTS = 500;
export const MAX_RECENT_DIALOGS = 20;
export const OBSERVED_DIALOG_TIMEOUT_MS = 120_000;

export type PlaywrightConnectionRetirement = {
  readonly retired: boolean;
  /** Capture handles created by already-admitted work before cleanup begins. */
  refresh?: () => boolean;
  close: () => Promise<void>;
};

export const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
export const connectingByCdpUrl = new Map<string, Promise<ConnectedBrowser>>();
export const closeConnectionPromises = new WeakMap<ConnectedBrowser, Promise<void>>();
export const PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS = 2_000;
export const blockedTargetsByCdpUrl = new Set<string>();
export const blockedPageRefsByCdpUrl = new Map<string, WeakSet<Page>>();
