/**
 * Browser client action helpers.
 *
 * Wraps browser-control action endpoints for navigation, dialog/file hooks,
 * screenshots, and element actions used by the Browser agent tool.
 */
import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import { fetchBrowserJson } from "./client-fetch.js";
import {
  DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
} from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";

export type { BrowserFormField } from "./client-actions.types.js";

type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: Array<{ ok: boolean; error?: string }>;
  blockedByDialog?: boolean;
  browserState?: unknown;
  /** Download info when a click/batch/evaluate action triggers a browser download. */
  downloads?: BrowserDownloadResult[];
};

const BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS = 5_000;
const BROWSER_DOWNLOAD_REQUEST_TIMEOUT_SLACK_MS = 5_000;

type BrowserDownloadActionResult = BrowserActionTabResult & { download: BrowserDownloadResult };

function normalizePositiveTimeoutMs(value: unknown): number | undefined {
  return clampPositiveTimerTimeoutMs(value);
}

function resolveBrowserActRequestTimeoutMs(req: BrowserActRequest): number {
  const explicitTimeout = normalizePositiveTimeoutMs((req as { timeoutMs?: unknown }).timeoutMs);
  const candidateTimeouts =
    explicitTimeout === undefined
      ? [DEFAULT_BROWSER_ACTION_TIMEOUT_MS]
      : [addTimerTimeoutGraceMs(explicitTimeout, BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS) ?? 1];
  if (req.kind === "wait") {
    const waitDuration = normalizePositiveTimeoutMs(req.timeMs);
    if (waitDuration !== undefined) {
      candidateTimeouts.push(
        addTimerTimeoutGraceMs(waitDuration, BROWSER_ACT_REQUEST_TIMEOUT_SLACK_MS) ?? 1,
      );
    }
  }
  return Math.max(...candidateTimeouts);
}

function resolveBrowserDownloadRequestTimeoutMs(timeoutMs: unknown): number {
  const waitTimeoutMs =
    normalizePositiveTimeoutMs(timeoutMs) ?? DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
  // Keep the HTTP client alive after the Playwright waiter expires so its
  // timeout/error response reaches the caller instead of a transport abort.
  return addTimerTimeoutGraceMs(waitTimeoutMs, BROWSER_DOWNLOAD_REQUEST_TIMEOUT_SLACK_MS) ?? 1;
}

async function postDownloadRequest(
  baseUrl: string | undefined,
  route: "/download" | "/wait/download",
  body: Record<string, unknown>,
  profile?: string,
  timeoutMs?: number,
): Promise<BrowserDownloadActionResult> {
  const q = buildProfileQuery(profile);
  return await fetchBrowserJson<BrowserDownloadActionResult>(withBaseUrl(baseUrl, `${route}${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: resolveBrowserDownloadRequestTimeoutMs(timeoutMs),
  });
}

/** Navigate a browser tab through the control server. */
export async function browserNavigate(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTabResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTabResult>(withBaseUrl(baseUrl, `/navigate${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

/** Arm a one-shot browser dialog handler. */
export async function browserArmDialog(
  baseUrl: string | undefined,
  opts: {
    accept: boolean;
    promptText?: string;
    dialogId?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/dialog${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accept: opts.accept,
      promptText: opts.promptText,
      dialogId: opts.dialogId,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

/** Arm or execute a browser file chooser upload. */
export async function browserArmFileChooser(
  baseUrl: string | undefined,
  opts: {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/file-chooser${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths: opts.paths,
      ref: opts.ref,
      inputRef: opts.inputRef,
      element: opts.element,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

/** Wait for the next managed browser download and save it under the guarded download root. */
export async function browserWaitForDownload(
  baseUrl: string | undefined,
  opts: {
    path?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadActionResult> {
  return await postDownloadRequest(
    baseUrl,
    "/wait/download",
    {
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
    opts.timeoutMs,
  );
}

/** Click a snapshot ref and save its download under the guarded download root. */
export async function browserDownload(
  baseUrl: string | undefined,
  opts: {
    ref: string;
    path: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadActionResult> {
  return await postDownloadRequest(
    baseUrl,
    "/download",
    {
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
    opts.timeoutMs,
  );
}

/** Execute one normalized browser action request. */
export async function browserAct(
  baseUrl: string | undefined,
  req: BrowserActRequest,
  opts?: { profile?: string; timeoutMs?: number },
): Promise<BrowserActResponse> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserActResponse>(withBaseUrl(baseUrl, `/act${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: resolveTimerTimeoutMs(opts?.timeoutMs, resolveBrowserActRequestTimeoutMs(req)),
  });
}

/** Capture a screenshot through the browser control server. */
export async function browserScreenshotAction(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    labels?: boolean;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  const timeoutMs = clampPositiveTimerTimeoutMs(opts.timeoutMs);
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/screenshot${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      fullPage: opts.fullPage,
      ref: opts.ref,
      element: opts.element,
      type: opts.type,
      labels: opts.labels,
      timeoutMs: effectiveTimeoutMs,
    }),
    timeoutMs: effectiveTimeoutMs,
  });
}
