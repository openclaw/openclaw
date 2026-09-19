/**
 * Browser client observation helpers.
 *
 * Wraps browser-control endpoints that read console/debug data or save page
 * output without directly mutating page state.
 */
import type { BrowserActionPathResult } from "./client-actions-types.js";
import {
  browserClientTimeout,
  postBrowserJson,
  requestBrowserJson,
  type BrowserClientTarget,
} from "./client-request.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";

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
