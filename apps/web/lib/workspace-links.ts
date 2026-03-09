/**
 * Workspace link utilities.
 *
 * All workspace links use the root route with query params:
 *   Files/docs:  /?path=knowledge/path/to/doc.md
 *   Objects:     /?path=knowledge/leads
 *   Entries:     /?entry=leads:abc123
 *   Chat:        /?chat=session-id
 *   Subagent:    /?chat=parent-id&subagent=child-key
 *   Browse:      /?browse=/abs/path&hidden=1
 *   Cron:        /?path=~cron  or  /?path=~cron/job-id
 *   Cron views:  /?path=~cron&cronView=calendar&cronCalMode=week&cronDate=2026-03-05
 *   Object view: /?path=leads&viewType=kanban&filters=...&sort=...&search=...&page=1&pageSize=50&cols=a,b,c&view=MyView
 *   Preview:     /?path=file.md&preview=other.md
 *   Send:        /?send=install+duckdb  (consumed immediately)
 *
 * Legacy /workspace?... links are accepted by parseWorkspaceLink and
 * migrateWorkspaceUrl for backward compat.
 */

import type { CalendarMode, FilterGroup, SortRule, ViewType } from "./object-filters";

// ---------------------------------------------------------------------------
// Parsed link (simple)
// ---------------------------------------------------------------------------

export type WorkspaceLink =
  | { kind: "file"; path: string }
  | { kind: "entry"; objectName: string; entryId: string };

// ---------------------------------------------------------------------------
// Full URL state
// ---------------------------------------------------------------------------

export type CronDashboardView = "overview" | "calendar" | "timeline" | "insights";
export type CronRunStatusFilter = "all" | "ok" | "error" | "running";

export type WorkspaceUrlState = {
  path: string | null;
  chat: string | null;
  subagent: string | null;
  /** File-scoped chat session (active when a file is open in the main panel). */
  fileChat: string | null;
  entry: { objectName: string; entryId: string } | null;
  send: string | null;
  browse: string | null;
  hidden: boolean;
  preview: string | null;
  view: string | null;
  viewType: ViewType | null;
  filters: FilterGroup | null;
  search: string | null;
  sort: SortRule[] | null;
  page: number | null;
  pageSize: number | null;
  cols: string[] | null;
  /** Cron dashboard active tab (only relevant when path is ~cron). */
  cronView: CronDashboardView | null;
  /** Calendar mode when cronView=calendar. */
  cronCalMode: CalendarMode | null;
  /** Date anchor for cron calendar/timeline view (ISO date string). */
  cronDate: string | null;
  /** Run status filter for cron job detail history. */
  cronRunFilter: CronRunStatusFilter | null;
  /** Selected run timestamp in cron job detail. */
  cronRun: number | null;
  /** Whether the terminal drawer is open. */
  terminal: boolean;
};

const VALID_VIEW_TYPES: ViewType[] = [
  "table", "kanban", "calendar", "timeline", "gallery", "list",
];

const VALID_CRON_VIEWS: CronDashboardView[] = ["overview", "calendar", "timeline", "insights"];
const VALID_CRON_CAL_MODES: CalendarMode[] = ["day", "week", "month", "year"];
const VALID_CRON_RUN_FILTERS: CronRunStatusFilter[] = ["all", "ok", "error", "running"];

// ---------------------------------------------------------------------------
// URL state codec
// ---------------------------------------------------------------------------

/** Parse search params (from any origin) into a typed WorkspaceUrlState. */
export function parseUrlState(search: string | URLSearchParams): WorkspaceUrlState {
  const params = typeof search === "string"
    ? new URLSearchParams(search)
    : search;

  let entry: WorkspaceUrlState["entry"] = null;
  const entryRaw = params.get("entry");
  if (entryRaw && entryRaw.includes(":")) {
    const idx = entryRaw.indexOf(":");
    entry = {
      objectName: entryRaw.slice(0, idx),
      entryId: entryRaw.slice(idx + 1),
    };
  }

  let filters: FilterGroup | null = null;
  const filtersRaw = params.get("filters");
  if (filtersRaw) {
    try {
      filters = JSON.parse(atob(filtersRaw)) as FilterGroup;
    } catch { /* invalid — ignore */ }
  }

  let sort: SortRule[] | null = null;
  const sortRaw = params.get("sort");
  if (sortRaw) {
    try {
      sort = JSON.parse(atob(sortRaw)) as SortRule[];
    } catch { /* invalid — ignore */ }
  }

  const pageRaw = params.get("page");
  const pageSizeRaw = params.get("pageSize");

  const colsRaw = params.get("cols");
  const viewTypeRaw = params.get("viewType") as ViewType | null;

  const cronViewRaw = params.get("cronView") as CronDashboardView | null;
  const cronCalModeRaw = params.get("cronCalMode") as CalendarMode | null;
  const cronRunFilterRaw = params.get("cronRunFilter") as CronRunStatusFilter | null;
  const cronRunRaw = params.get("cronRun");

  return {
    path: params.get("path"),
    chat: params.get("chat"),
    subagent: params.get("subagent"),
    fileChat: params.get("fileChat"),
    entry,
    send: params.get("send"),
    browse: params.get("browse"),
    hidden: params.get("hidden") === "1",
    preview: params.get("preview"),
    view: params.get("view"),
    viewType:
      viewTypeRaw && VALID_VIEW_TYPES.includes(viewTypeRaw)
        ? viewTypeRaw
        : null,
    filters,
    search: params.get("search"),
    sort,
    page: pageRaw ? parseInt(pageRaw, 10) || null : null,
    pageSize: pageSizeRaw ? parseInt(pageSizeRaw, 10) || null : null,
    cols: colsRaw ? colsRaw.split(",").filter(Boolean) : null,
    cronView: cronViewRaw && VALID_CRON_VIEWS.includes(cronViewRaw) ? cronViewRaw : null,
    cronCalMode: cronCalModeRaw && VALID_CRON_CAL_MODES.includes(cronCalModeRaw) ? cronCalModeRaw : null,
    cronDate: params.get("cronDate"),
    cronRunFilter: cronRunFilterRaw && VALID_CRON_RUN_FILTERS.includes(cronRunFilterRaw) ? cronRunFilterRaw : null,
    cronRun: cronRunRaw ? parseInt(cronRunRaw, 10) || null : null,
    terminal: params.get("terminal") === "1",
  };
}

/** Serialize a (partial) WorkspaceUrlState to a query string. Omits null/default values. */
export function serializeUrlState(state: Partial<WorkspaceUrlState>): string {
  const params = new URLSearchParams();

  if (state.path) params.set("path", state.path);
  if (state.chat) params.set("chat", state.chat);
  if (state.subagent) params.set("subagent", state.subagent);
  if (state.fileChat) params.set("fileChat", state.fileChat);
  if (state.entry) {
    params.set("entry", `${state.entry.objectName}:${state.entry.entryId}`);
  }
  if (state.send) params.set("send", state.send);
  if (state.browse) params.set("browse", state.browse);
  if (state.hidden) params.set("hidden", "1");
  if (state.preview) params.set("preview", state.preview);
  if (state.view) params.set("view", state.view);
  if (state.viewType) params.set("viewType", state.viewType);
  if (state.filters && state.filters.rules.length > 0) {
    params.set("filters", btoa(JSON.stringify(state.filters)));
  }
  if (state.search) params.set("search", state.search);
  if (state.sort && state.sort.length > 0) {
    params.set("sort", btoa(JSON.stringify(state.sort)));
  }
  if (state.page != null && state.page > 1) params.set("page", String(state.page));
  if (state.pageSize != null) params.set("pageSize", String(state.pageSize));
  if (state.cols && state.cols.length > 0) params.set("cols", state.cols.join(","));
  if (state.cronView && state.cronView !== "overview") params.set("cronView", state.cronView);
  if (state.cronCalMode) params.set("cronCalMode", state.cronCalMode);
  if (state.cronDate) params.set("cronDate", state.cronDate);
  if (state.cronRunFilter && state.cronRunFilter !== "all") params.set("cronRunFilter", state.cronRunFilter);
  if (state.cronRun != null) params.set("cronRun", String(state.cronRun));
  if (state.terminal) params.set("terminal", "1");

  return params.toString();
}

// ---------------------------------------------------------------------------
// Workspace URL sync param builder
// ---------------------------------------------------------------------------

const OBJECT_VIEW_PARAMS = ["viewType", "view", "filters", "search", "sort", "page", "pageSize", "cols"];

export interface WorkspaceSyncState {
  activePath: string | null;
  activeSessionId: string | null;
  activeSubagentKey: string | null;
  fileChatSessionId: string | null;
  browseDir: string | null;
  showHidden: boolean;
  previewPath: string | null;
  terminalOpen: boolean;
  cronView: CronDashboardView;
  cronCalMode: CalendarMode;
  cronDate: string | null;
  cronRunFilter: CronRunStatusFilter;
  cronRun: number | null;
}

/**
 * Build the URL params that the workspace URL sync effect should push.
 *
 * Pure function: takes app state + the current URL params (for preserving
 * object-view and entry params managed by other effects) and returns the
 * complete URLSearchParams to write.
 */
export function buildWorkspaceSyncParams(
  state: WorkspaceSyncState,
  currentParams: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams();

  if (state.activePath) {
    params.set("path", state.activePath);
    const entry = currentParams.get("entry");
    if (entry) params.set("entry", entry);
    if (state.fileChatSessionId) params.set("fileChat", state.fileChatSessionId);

    if (state.activePath === "~cron") {
      if (state.cronView !== "overview") params.set("cronView", state.cronView);
      if (state.cronView === "calendar" && state.cronCalMode !== "month") params.set("cronCalMode", state.cronCalMode);
      if ((state.cronView === "calendar" || state.cronView === "timeline") && state.cronDate) params.set("cronDate", state.cronDate);
    } else if (state.activePath.startsWith("~cron/")) {
      if (state.cronRunFilter !== "all") params.set("cronRunFilter", state.cronRunFilter);
      if (state.cronRun != null) params.set("cronRun", String(state.cronRun));
    }

    for (const k of OBJECT_VIEW_PARAMS) {
      const v = currentParams.get(k);
      if (v) params.set(k, v);
    }
  } else if (state.activeSessionId) {
    params.set("chat", state.activeSessionId);
    if (state.activeSubagentKey) params.set("subagent", state.activeSubagentKey);
  }

  if (state.browseDir) params.set("browse", state.browseDir);
  if (state.showHidden) params.set("hidden", "1");
  if (state.previewPath) params.set("preview", state.previewPath);
  if (state.terminalOpen) params.set("terminal", "1");

  return params;
}

/** Build a full root-route URL string from partial state. */
export function buildUrl(state: Partial<WorkspaceUrlState>): string {
  const qs = serializeUrlState(state);
  return qs ? `/?${qs}` : "/";
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * Convert a legacy /workspace?... URL to the equivalent root URL.
 * Returns null if the href is not a legacy workspace URL.
 */
export function migrateWorkspaceUrl(href: string): string | null {
  const isLegacy =
    href === "/workspace" ||
    href.startsWith("/workspace?") ||
    href.startsWith("/workspace#");

  if (!isLegacy) return null;

  if (href === "/workspace") return "/";

  const qIdx = href.indexOf("?");
  const hIdx = href.indexOf("#");

  let qs = "";
  let hash = "";

  if (qIdx >= 0) {
    const endOfQs = hIdx > qIdx ? hIdx : href.length;
    qs = href.slice(qIdx, endOfQs);
  }
  if (hIdx >= 0) {
    hash = href.slice(hIdx);
  }

  return `/${qs}${hash}`;
}

// ---------------------------------------------------------------------------
// Simple link builders
// ---------------------------------------------------------------------------

/** Build a URL for an entry detail modal. */
export function buildEntryLink(objectName: string, entryId: string): string {
  return `/?entry=${encodeURIComponent(objectName)}:${encodeURIComponent(entryId)}`;
}

/** Build a URL for a file or object in the workspace. */
export function buildFileLink(path: string): string {
  return `/?path=${encodeURIComponent(path)}`;
}

/** Build a URL for a chat session. */
export function buildChatLink(sessionId: string): string {
  return `/?chat=${encodeURIComponent(sessionId)}`;
}

/** Build a URL for a subagent panel. */
export function buildSubagentLink(chatId: string, subagentKey: string): string {
  return `/?chat=${encodeURIComponent(chatId)}&subagent=${encodeURIComponent(subagentKey)}`;
}

/** Build a URL for browse mode. */
export function buildBrowseLink(dir: string, showHidden?: boolean): string {
  const p = new URLSearchParams();
  p.set("browse", dir);
  if (showHidden) p.set("hidden", "1");
  return `/?${p.toString()}`;
}

// ---------------------------------------------------------------------------
// Simple link parsers / predicates
// ---------------------------------------------------------------------------

function tryParseAppUrl(href: string): URL | null {
  try {
    if (href.startsWith("/")) {
      return new URL(href, "http://localhost");
    }
    const u = new URL(href);
    if (u.pathname === "/" || u.pathname === "/workspace") return u;
  } catch { /* invalid */ }
  return null;
}

/** Parse a workspace URL into a structured link. Accepts both root and legacy /workspace URLs. */
export function parseWorkspaceLink(href: string): WorkspaceLink | null {
  const url = tryParseAppUrl(href);

  if (url && (url.pathname === "/" || url.pathname === "/workspace")) {
    const entryParam = url.searchParams.get("entry");
    if (entryParam && entryParam.includes(":")) {
      const colonIdx = entryParam.indexOf(":");
      return {
        kind: "entry",
        objectName: entryParam.slice(0, colonIdx),
        entryId: entryParam.slice(colonIdx + 1),
      };
    }

    const pathParam = url.searchParams.get("path");
    if (pathParam) {
      return { kind: "file", path: pathParam };
    }
  }

  // Legacy: handle old @entry/ format for backward compat
  if (href.startsWith("@entry/")) {
    const rest = href.slice("@entry/".length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx > 0) {
      return {
        kind: "entry",
        objectName: rest.slice(0, slashIdx),
        entryId: rest.slice(slashIdx + 1),
      };
    }
  }

  return null;
}

/** Check if an href is an app-internal workspace link (root, legacy /workspace, or @entry/). */
export function isWorkspaceLink(href: string): boolean {
  if (href.startsWith("@entry/")) return true;
  // Legacy /workspace links
  if (
    href === "/workspace" ||
    href.startsWith("/workspace?") ||
    href.startsWith("/workspace#")
  ) return true;
  // New root links with query params
  if (href === "/") return true;
  if (href.startsWith("/?")) return true;
  if (href.startsWith("/#")) return true;
  return false;
}

/** Check if an href is a workspace-internal link (not external URL). */
export function isInternalLink(href: string): boolean {
  return (
    !href.startsWith("http://") &&
    !href.startsWith("https://") &&
    !href.startsWith("mailto:")
  );
}

/** Check if an href is an entry link (any format). */
export function isEntryLink(href: string): boolean {
  if (href.startsWith("@entry/")) return true;
  if ((href.startsWith("/") || href.startsWith("/workspace")) && href.includes("entry=")) return true;
  return false;
}
