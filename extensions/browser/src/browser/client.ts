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
  ProfileStatus,
  SnapshotAriaNode,
} from "./client.types.js";
import { DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS } from "./constants.js";
import type { BrowserDoctorReport } from "./doctor.js";
import type { AnnotationItem } from "./screenshot-annotate.js";
import type {
  ImportSystemProfileResult as BrowserImportProfileResult,
  SystemProfileInfo,
} from "./system-profiles.js";

export type {
  ImportSystemProfileResult as BrowserImportProfileResult,
  SystemProfileInfo,
} from "./system-profiles.js";

export type {
  BrowserStatus,
  BrowserTab,
  BrowserTabsResult,
  ProfileStatus,
} from "./client.types.js";
export type { BrowserDoctorReport } from "./doctor.js";

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

export type BrowserResetProfileResult = {
  ok: true;
  moved: boolean;
  from: string;
  to?: string;
};

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

export async function browserStart(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<void> {
  await sendProfilePost(baseUrl, "/start", opts, 15000);
}

export async function browserStop(
  baseUrl?: BrowserClientTarget,
  opts?: BrowserClientProfileOptions,
): Promise<void> {
  await sendProfilePost(baseUrl, "/stop", opts, 15000);
}

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

export type BrowserDeleteProfileResult = {
  ok: true;
  profile: string;
  deleted: boolean;
};

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

export async function browserCloseTab(
  baseUrl: BrowserClientTarget,
  targetId: string,
  opts?: BrowserClientProfileOptions,
): Promise<{ ok: true; targetId?: string }> {
  const path = `/tabs/${encodeURIComponent(targetId)}`;
  return await requestBrowserJson(baseUrl, path, {
    profile: opts?.profile,
    method: "DELETE",
    timeoutMs: browserClientTimeout(baseUrl, opts?.timeoutMs, 5000),
    signal: opts?.signal,
  });
}

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
  const resolvedTimeoutMs =
    clampPositiveTimerTimeoutMs(opts.timeoutMs) ?? DEFAULT_BROWSER_SNAPSHOT_TIMEOUT_MS;
  return await requestBrowserJson<SnapshotResult>(baseUrl, "/snapshot", {
    query: {
      ...(opts.format ? { format: opts.format } : {}),
      ...(opts.targetId ? { targetId: opts.targetId } : {}),
      ...(typeof opts.limit === "number" ? { limit: opts.limit } : {}),
      ...(typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
        ? { maxChars: opts.maxChars }
        : {}),
      ...(opts.refs === "aria" || opts.refs === "role" ? { refs: opts.refs } : {}),
      ...(typeof opts.interactive === "boolean" ? { interactive: opts.interactive } : {}),
      ...(typeof opts.compact === "boolean" ? { compact: opts.compact } : {}),
      ...(typeof opts.depth === "number" && Number.isFinite(opts.depth)
        ? { depth: opts.depth }
        : {}),
      ...(opts.selector?.trim() ? { selector: opts.selector.trim() } : {}),
      ...(opts.frame?.trim() ? { frame: opts.frame.trim() } : {}),
      ...(opts.labels === true ? { labels: "1" } : {}),
      ...(opts.urls === true ? { urls: "1" } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      timeoutMs: resolvedTimeoutMs,
    },
    profile: opts.profile,
    timeoutMs: resolvedTimeoutMs,
    signal: opts.signal,
  });
}
