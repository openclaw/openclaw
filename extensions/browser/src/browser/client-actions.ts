import {
  addTimerTimeoutGraceMs,
  clampPositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  BROWSER_ACTION_TRANSPORT_SLACK_MS,
  resolveBrowserActRequestTimeoutMs,
  resolveBrowserNavigationTimeoutMs,
} from "./act-policy.js";
import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
  BrowserBatchAbort,
  BrowserBatchActionResult,
} from "./client-actions-types.js";
import type { BrowserActRequest } from "./client-actions.types.js";
import {
  browserClientTimeout,
  postBrowserJson,
  requestBrowserJson,
  type BrowserClientTarget,
} from "./client-request.js";
import {
  DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS,
} from "./constants.js";
import type { BrowserDownloadResult } from "./download-types.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: BrowserBatchActionResult[];
  aborted?: BrowserBatchAbort;
  blockedByDialog?: boolean;
  browserState?: unknown;
  /** Download info when a click/batch/evaluate action triggers a browser download. */
  downloads?: BrowserDownloadResult[];
};

type BrowserDownloadActionResult = BrowserActionTabResult & { download: BrowserDownloadResult };

function resolveBrowserOperationRequestTimeoutMs(timeoutMs: unknown): number {
  const operationTimeoutMs =
    clampPositiveTimerTimeoutMs(timeoutMs) ?? DEFAULT_BROWSER_DOWNLOAD_TIMEOUT_MS;
  // Let the browser operation report its own timeout/error before the client watchdog fires.
  return addTimerTimeoutGraceMs(operationTimeoutMs, BROWSER_ACTION_TRANSPORT_SLACK_MS) ?? 1;
}

/** Navigate a browser tab through the control server. */
export async function browserNavigate(
  baseUrl: BrowserClientTarget,
  opts: {
    url: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserActionTabResult> {
  const timeoutMs = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  return await postBrowserJson(
    baseUrl,
    "/navigate",
    { url: opts.url, targetId: opts.targetId, timeoutMs },
    resolveBrowserOperationRequestTimeoutMs(timeoutMs),
    opts,
  );
}

/** Arm a one-shot browser dialog handler. */
export async function browserArmDialog(
  baseUrl: BrowserClientTarget,
  opts: {
    accept: boolean;
    promptText?: string;
    dialogId?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserActionOk> {
  return await postBrowserJson(
    baseUrl,
    "/hooks/dialog",
    {
      accept: opts.accept,
      promptText: opts.promptText,
      dialogId: opts.dialogId,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    browserClientTimeout(
      baseUrl,
      undefined,
      resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    ),
    opts,
  );
}

/** Arm or execute a browser file chooser upload. */
export async function browserArmFileChooser(
  baseUrl: BrowserClientTarget,
  opts: {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserActionOk> {
  return await postBrowserJson(
    baseUrl,
    "/hooks/file-chooser",
    {
      paths: opts.paths,
      ref: opts.ref,
      inputRef: opts.inputRef,
      element: opts.element,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    },
    browserClientTimeout(
      baseUrl,
      undefined,
      resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    ),
    opts,
  );
}

/** Wait for the next managed browser download and save it under the guarded download root. */
export async function browserWaitForDownload(
  baseUrl: BrowserClientTarget,
  opts: {
    path?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserDownloadActionResult> {
  return await postBrowserJson(
    baseUrl,
    "/wait/download",
    {
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    opts,
  );
}

/** Click a snapshot ref and save its download under the guarded download root. */
export async function browserDownload(
  baseUrl: BrowserClientTarget,
  opts: {
    ref: string;
    path: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserDownloadActionResult> {
  return await postBrowserJson(
    baseUrl,
    "/download",
    {
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    resolveBrowserOperationRequestTimeoutMs(opts.timeoutMs),
    opts,
  );
}

/** Execute one normalized browser action request. */
export async function browserAct(
  baseUrl: BrowserClientTarget,
  req: BrowserActRequest,
  opts?: { profile?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<BrowserActResponse> {
  return await postBrowserJson(
    baseUrl,
    "/act",
    req,
    resolveTimerTimeoutMs(opts?.timeoutMs, resolveBrowserActRequestTimeoutMs(req)),
    opts,
  );
}

/** Capture a screenshot through the browser control server. */
export async function browserScreenshotAction(
  baseUrl: BrowserClientTarget,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    labels?: boolean;
    timeoutMs?: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<BrowserActionPathResult> {
  const timeoutMs = clampPositiveTimerTimeoutMs(opts.timeoutMs);
  const effectiveTimeoutMs = timeoutMs ?? DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
  return await postBrowserJson(
    baseUrl,
    "/screenshot",
    {
      targetId: opts.targetId,
      fullPage: opts.fullPage,
      ref: opts.ref,
      element: opts.element,
      type: opts.type,
      labels: opts.labels,
      timeoutMs: effectiveTimeoutMs,
    },
    effectiveTimeoutMs,
    opts,
  );
}

function buildQuery(params: Array<[string, string | boolean | undefined]>) {
  const query: Record<string, string | boolean | undefined> = {};
  for (const [key, value] of params) {
    if (typeof value === "boolean") {
      query[key] = value;
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      query[key] = value;
    }
  }
  return query;
}

/** Read browser console messages for a tab. */
export async function browserConsoleMessages(
  baseUrl: BrowserClientTarget,
  opts: { level?: string; targetId?: string; profile?: string; signal?: AbortSignal } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string; url?: string }> {
  const query = buildQuery([
    ["level", opts.level],
    ["targetId", opts.targetId],
  ]);
  return await requestBrowserJson(baseUrl, "/console", {
    query,
    profile: opts.profile,
    timeoutMs: browserClientTimeout(baseUrl, undefined, 20000),
    signal: opts.signal,
  });
}

/** Read the collected network request log for a tab. */
export async function browserRequests(
  baseUrl: BrowserClientTarget,
  opts: {
    filter?: string;
    clear?: boolean;
    targetId?: string;
    profile?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; requests: BrowserNetworkRequest[]; targetId: string; url?: string }> {
  const query = buildQuery([
    ["filter", opts.filter],
    ["clear", opts.clear],
    ["targetId", opts.targetId],
  ]);
  return await requestBrowserJson(baseUrl, "/requests", {
    query,
    profile: opts.profile,
    timeoutMs: browserClientTimeout(baseUrl, undefined, 20000),
    signal: opts.signal,
  });
}

/** Read the collected page error log for a tab. */
export async function browserErrors(
  baseUrl: BrowserClientTarget,
  opts: {
    clear?: boolean;
    targetId?: string;
    profile?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{ ok: true; errors: BrowserPageError[]; targetId: string; url?: string }> {
  const query = buildQuery([
    ["clear", opts.clear],
    ["targetId", opts.targetId],
  ]);
  return await requestBrowserJson(baseUrl, "/errors", {
    query,
    profile: opts.profile,
    timeoutMs: browserClientTimeout(baseUrl, undefined, 20000),
    signal: opts.signal,
  });
}

/** Read bounded visible text without executing page-supplied code. */
export async function browserPageText(
  baseUrl: BrowserClientTarget,
  opts: {
    targetId?: string;
    selector?: string;
    maxChars: number;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; targetId: string; url?: string; text: string; truncated: boolean }> {
  const query = {
    ...buildQuery([
      ["targetId", opts.targetId],
      ["selector", opts.selector],
    ]),
    maxChars: opts.maxChars,
  };
  return await requestBrowserJson(baseUrl, "/text", {
    query,
    profile: opts.profile,
    timeoutMs: browserClientTimeout(baseUrl, undefined, 20000),
    signal: opts.signal,
  });
}

/** Apply one of the browser control service's existing emulation settings. */
export async function browserEmulateSetting(
  baseUrl: BrowserClientTarget,
  opts: {
    setting: "device" | "media" | "timezone" | "locale";
    body: Record<string, string | undefined>;
    profile?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: true; targetId: string }> {
  return await postBrowserJson(
    baseUrl,
    `/set/${opts.setting}`,
    opts.body,
    browserClientTimeout(baseUrl, undefined, 20000),
    opts,
  );
}

/** Save the current page as PDF through browser control. */
export async function browserPdfSave(
  baseUrl: BrowserClientTarget,
  opts: { targetId?: string; profile?: string; signal?: AbortSignal } = {},
): Promise<BrowserActionPathResult> {
  return await postBrowserJson(
    baseUrl,
    "/pdf",
    { targetId: opts.targetId },
    browserClientTimeout(baseUrl, undefined, 20000),
    opts,
  );
}
