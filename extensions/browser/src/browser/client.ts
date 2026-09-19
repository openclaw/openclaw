/**
 * Browser control client API.
 *
 * Provides typed helpers for status, profile lifecycle, tabs, and snapshots
 * over the browser-control transport.
 */
import { clampPositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  browserClientTimeout,
  postBrowserJson,
  requestBrowserJson,
  type BrowserClientTarget,
} from "./client-request.js";
import type {
  BrowserOpenResult,
  BrowserStatus,
  BrowserTabsResult,
  BrowserTransport,
  SnapshotAriaNode,
} from "./client.types.js";
import { DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import type { BrowserDoctorReport } from "./doctor.js";
import type { AnnotationItem } from "./screenshot-annotate.js";

export type {
  BrowserStatus,
  BrowserTab,
  BrowserTabsResult,
  BrowserTransport,
} from "./client.types.js";
export type { BrowserDoctorCheck, BrowserDoctorReport } from "./doctor.js";

const BROWSER_STATUS_REQUEST_TIMEOUT_MS = 7_500;
const BROWSER_DOCTOR_REQUEST_TIMEOUT_MS = 7_500;
const BROWSER_DEEP_DOCTOR_REQUEST_TIMEOUT_MS = 10_000;

type BrowserClientTimeoutOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type BrowserClientProfileOptions = BrowserClientTimeoutOptions & {
  profile?: string;
};

async function sendProfilePost(
  baseUrl: BrowserClientTarget,
  path: string,
  opts: BrowserClientProfileOptions | undefined,
  fallbackTimeoutMs: number,
): Promise<void> {
  await requestBrowserJson(baseUrl, path, {
    profile: opts?.profile,
    method: "POST",
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, fallbackTimeoutMs),
    signal: opts?.signal,
  });
}

async function sendTabCloseRequest(
  baseUrl: BrowserClientTarget,
  path: string,
  opts: BrowserClientProfileOptions | undefined,
): Promise<{ ok: true; targetId?: string }> {
  return await requestBrowserJson(baseUrl, path, {
    profile: opts?.profile,
    method: "DELETE",
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 5000),
    signal: opts?.signal,
  });
}

/** Profile status record returned by browser profile listing. */
export type ProfileStatus = {
  name: string;
  transport?: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  color: string;
  driver: "openclaw" | "existing-session" | "extension";
  running: boolean;
  tabCount: number;
  isDefault: boolean;
  isRemote: boolean;
  missingFromConfig?: boolean;
  reconcileReason?: string | null;
};

export type SystemProfileInfo = {
  browser: "chrome" | "brave" | "edge" | "chromium";
  id: string;
  name: string;
  hasCookies: boolean;
};

export type BrowserImportProfileResult = {
  ok: true;
  systemProfile: string;
  into: string;
  browser: SystemProfileInfo["browser"];
  cookies: { total: number; imported: number; failed: number; skipped: number };
  domains: string[];
};

/** Result returned when a managed browser profile directory is reset. */
export type BrowserResetProfileResult = {
  ok: true;
  moved: boolean;
  from: string;
  to?: string;
};

/** Snapshot response returned by browserSnapshot. */
export type SnapshotResult =
  | {
      ok: true;
      format: "aria";
      targetId: string;
      url: string;
      nodes: SnapshotAriaNode[];
      truncated?: boolean;
      blockedByDialog?: boolean;
      browserState?: unknown;
    }
  | {
      ok: true;
      format: "ai";
      targetId: string;
      url: string;
      snapshot: string;
      truncated?: boolean;
      newElements?: number;
      refs?: Record<string, { role: string; name?: string; nth?: number }>;
      stats?: {
        lines: number;
        chars: number;
        refs: number;
        interactive: number;
      };
      labels?: boolean;
      labelsCount?: number;
      labelsSkipped?: number;
      /**
       * Per-ref bounding boxes when labels=true. Coordinates are in the
       * captured image's space. Omitted when empty.
       */
      annotations?: AnnotationItem[];
      imagePath?: string;
      imageType?: "png" | "jpeg";
      blockedByDialog?: boolean;
      browserState?: unknown;
    };

/** Read browser-control status for the selected profile. */
export async function browserStatus(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<BrowserStatus> {
  return await requestBrowserJson<BrowserStatus>(baseUrl, "/", {
    profile: opts?.profile,
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, BROWSER_STATUS_REQUEST_TIMEOUT_MS),
    signal: opts?.signal,
  });
}

/** Run browser doctor checks for the selected profile. */
export async function browserDoctor(
  baseUrl?: BrowserClientTarget,
  opts?: { profile?: string; deep?: boolean; signal?: AbortSignal },
): Promise<BrowserDoctorReport> {
  return await requestBrowserJson(baseUrl, "/doctor", {
    profile: opts?.profile,
    query: opts?.deep ? { deep: "true" } : undefined,
    timeoutMs: browserClientTimeout(
      baseUrl,
      undefined,
      opts?.deep ? BROWSER_DEEP_DOCTOR_REQUEST_TIMEOUT_MS : BROWSER_DOCTOR_REQUEST_TIMEOUT_MS,
    ),
    signal: opts?.signal,
  });
}

/** List configured browser profiles and their current status. */
export async function browserProfiles(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientTimeoutOptions,
): Promise<ProfileStatus[]> {
  const res = await requestBrowserJson<{ profiles: ProfileStatus[] }>(baseUrl, "/profiles", {
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 3000),
    signal: opts?.signal,
  });
  return res.profiles ?? [];
}

/** List Chrome-family profiles available on the local macOS host. */
export async function browserSystemProfiles(
  baseUrl?: BrowserClientTarget,
  opts?: { browser?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<SystemProfileInfo[]> {
  const res = await requestBrowserJson<{ systemProfiles: SystemProfileInfo[] }>(
    baseUrl,
    "/system-profiles",
    {
      query: opts?.browser ? { browser: opts.browser } : undefined,
      timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 3000),
      signal: opts?.signal,
    },
  );
  return res.systemProfiles ?? [];
}

/** Import system-profile cookies into a managed browser profile. */
export async function browserImportProfile(
  baseUrl: BrowserClientTarget,
  opts: {
    browser?: string;
    systemProfile?: string;
    into?: string;
    domains?: string[];
    signal?: AbortSignal;
  },
): Promise<BrowserImportProfileResult> {
  return await postBrowserJson(
    baseUrl,
    "/profiles/import",
    {
      browser: opts.browser,
      systemProfile: opts.systemProfile,
      into: opts.into,
      domains: opts.domains,
    },
    120_000,
    { signal: opts.signal },
  );
}

/** Start the selected browser profile. */
export async function browserStart(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<void> {
  await sendProfilePost(baseUrl, "/start", opts, 15000);
}

/** Stop the selected browser profile. */
export async function browserStop(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<void> {
  await sendProfilePost(baseUrl, "/stop", opts, 15000);
}

/** Reset the selected managed browser profile directory. */
export async function browserResetProfile(
  baseUrl?: BrowserClientTarget,
  opts?: { profile?: string },
): Promise<BrowserResetProfileResult> {
  return await requestBrowserJson<BrowserResetProfileResult>(baseUrl, "/reset-profile", {
    profile: opts?.profile,
    method: "POST",
    timeoutMs: 20000,
  });
}

/** Result returned after creating a browser profile. */
export type BrowserCreateProfileResult = {
  ok: true;
  profile: string;
  transport?: BrowserTransport;
  cdpPort: number | null;
  cdpUrl: string | null;
  userDataDir: string | null;
  color: string;
  isRemote: boolean;
};

/** Create and persist a browser profile. */
export async function browserCreateProfile(
  baseUrl: BrowserClientTarget,
  opts: {
    name: string;
    color?: string;
    cdpUrl?: string;
    userDataDir?: string;
    driver?: "openclaw" | "existing-session";
  },
): Promise<BrowserCreateProfileResult> {
  return await postBrowserJson(
    baseUrl,
    "/profiles/create",
    {
      name: opts.name,
      color: opts.color,
      cdpUrl: opts.cdpUrl,
      userDataDir: opts.userDataDir,
      driver: opts.driver,
    },
    10000,
  );
}

/** Result returned after deleting a browser profile. */
export type BrowserDeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

/** Delete a configured browser profile. */
export async function browserDeleteProfile(
  baseUrl: BrowserClientTarget,
  profile: string,
): Promise<BrowserDeleteProfileResult> {
  return await requestBrowserJson<BrowserDeleteProfileResult>(
    baseUrl,
    `/profiles/${encodeURIComponent(profile)}`,
    {
      method: "DELETE",
      timeoutMs: 20000,
    },
  );
}

function normalizeBrowserTabsResult(value: unknown): BrowserTabsResult {
  const result = asNullableRecord(value);
  if (result?.running === false) {
    return { running: false, tabs: [] };
  }
  return {
    running: true,
    tabs: Array.isArray(result?.tabs) ? result.tabs : [],
  };
}

export async function browserTabs(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<BrowserTabsResult> {
  const res = await requestBrowserJson<BrowserTabsResult>(baseUrl, "/tabs", {
    profile: opts?.profile,
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 3000),
    signal: opts?.signal,
  });
  return normalizeBrowserTabsResult(res);
}

/** Open a new tab in the selected browser profile. */
export async function browserOpenTab(
  baseUrl: BrowserClientTarget,
  url: string,
  opts?: {
    profile?: string;
    label?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    managedOnly?: boolean;
  },
): Promise<BrowserOpenResult> {
  return await postBrowserJson(
    baseUrl,
    "/tabs/open",
    {
      url,
      ...(opts?.label ? { label: opts.label } : {}),
      ...(opts?.managedOnly ? { managedOnly: true } : {}),
    },
    browserClientTimeout(baseUrl, opts?.timeoutMs, 15000),
    opts,
  );
}

/** Focus an existing browser tab. */
export async function browserFocusTab(
  baseUrl: BrowserClientTarget,
  targetId: string,
  opts?: BrowserClientProfileOptions,
): Promise<{ ok: true; targetId?: string }> {
  return await postBrowserJson(
    baseUrl,
    "/tabs/focus",
    { targetId },
    browserClientTimeout(baseUrl, opts?.timeoutMs, 5000),
    opts,
  );
}

/** Close an existing browser tab. */
export async function browserCloseTab(
  baseUrl: BrowserClientTarget,
  targetId: string,
  opts?: BrowserClientProfileOptions,
): Promise<{ ok: true; targetId?: string }> {
  const path = `/tabs/${encodeURIComponent(targetId)}`;
  return await sendTabCloseRequest(baseUrl, path, opts);
}

/** Close a canonical raw target id selected by OpenClaw's internal tab bookkeeping. */
export async function browserCloseTabByRawTargetId(
  baseUrl: BrowserClientTarget,
  targetId: string,
  opts?: BrowserClientProfileOptions,
): Promise<void> {
  const path = `/tabs/${encodeURIComponent(targetId)}?targetIdMode=raw`;
  await sendTabCloseRequest(baseUrl, path, opts);
}

/** Execute legacy index-based tab actions. */
export async function browserTabAction(
  baseUrl: BrowserClientTarget,
  opts: {
    action: "list" | "new" | "close" | "select";
    index?: number;
    profile?: string;
  },
): Promise<unknown> {
  return await postBrowserJson(
    baseUrl,
    "/tabs/action",
    { action: opts.action, index: opts.index },
    10_000,
    { profile: opts.profile },
  );
}

/** Capture an ARIA or AI snapshot for the selected tab. */
export async function browserSnapshot(
  baseUrl: BrowserClientTarget,
  opts: {
    format?: "aria" | "ai";
    targetId?: string;
    limit?: number;
    maxChars?: number;
    refs?: "role" | "aria";
    interactive?: boolean;
    compact?: boolean;
    depth?: number;
    selector?: string;
    frame?: string;
    labels?: boolean;
    urls?: boolean;
    mode?: "efficient";
    profile?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<SnapshotResult> {
  const q: Record<string, string | number | boolean | undefined> = {};
  if (opts.format) {
    q.format = opts.format;
  }
  if (opts.targetId) {
    q.targetId = opts.targetId;
  }
  if (typeof opts.limit === "number") {
    q.limit = opts.limit;
  }
  if (typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)) {
    q.maxChars = opts.maxChars;
  }
  if (opts.refs === "aria" || opts.refs === "role") {
    q.refs = opts.refs;
  }
  if (typeof opts.interactive === "boolean") {
    q.interactive = opts.interactive;
  }
  if (typeof opts.compact === "boolean") {
    q.compact = opts.compact;
  }
  if (typeof opts.depth === "number" && Number.isFinite(opts.depth)) {
    q.depth = opts.depth;
  }
  if (opts.selector?.trim()) {
    q.selector = opts.selector.trim();
  }
  if (opts.frame?.trim()) {
    q.frame = opts.frame.trim();
  }
  if (opts.labels === true) {
    q.labels = "1";
  }
  if (opts.urls === true) {
    q.urls = "1";
  }
  if (opts.mode) {
    q.mode = opts.mode;
  }
  const resolvedTimeoutMs =
    clampPositiveTimerTimeoutMs(opts.timeoutMs) ?? DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS;
  q.timeoutMs = resolvedTimeoutMs;
  return await requestBrowserJson<SnapshotResult>(baseUrl, "/snapshot", {
    query: q,
    profile: opts.profile,
    timeoutMs: resolvedTimeoutMs,
    signal: opts.signal,
  });
}

// Actions beyond the basic read-only commands live in client-actions.ts.
