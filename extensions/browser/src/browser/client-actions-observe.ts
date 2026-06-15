/**
 * Browser client observation helpers.
 *
 * Wraps browser-control endpoints that read console/debug data or save page
 * output without directly mutating page state.
 */
import type { BrowserActionPathResult } from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";
import type { BrowserConsoleMessage } from "./pw-session.js";

function buildQuerySuffix(params: Array<[string, string | boolean | undefined]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of params) {
    if (typeof value === "boolean") {
      query.set(key, String(value));
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}

/** Read browser console messages for a tab. */
export async function browserConsoleMessages(
  baseUrl: string | undefined,
  opts: { level?: string; targetId?: string; profile?: string } = {},
): Promise<{ ok: true; messages: BrowserConsoleMessage[]; targetId: string; url?: string }> {
  const suffix = buildQuerySuffix([
    ["level", opts.level],
    ["targetId", opts.targetId],
    ["profile", opts.profile],
  ]);
  return await fetchBrowserJson<{
    ok: true;
    messages: BrowserConsoleMessage[];
    targetId: string;
    url?: string;
  }>(withBaseUrl(baseUrl, `/console${suffix}`), { timeoutMs: 20000 });
}

/** Save the current page as PDF through browser control. */
export async function browserPdfSave(
  baseUrl: string | undefined,
  opts: { targetId?: string; profile?: string } = {},
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/pdf${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

type BrowserDownloadResult = {
  ok: true;
  targetId: string;
  download: { url: string; suggestedFilename: string; path: string };
};

/** Click an element via ref and wait for the download to complete. */
export async function browserDownload(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    ref: string;
    path: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserDownloadResult>(withBaseUrl(baseUrl, `/download${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 60000,
  });
}

/** Wait for a pending download without clicking. */
export async function browserWaitForDownload(
  baseUrl: string | undefined,
  opts: {
    targetId?: string;
    path?: string;
    timeoutMs?: number;
    profile?: string;
  } = {},
): Promise<BrowserDownloadResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserDownloadResult>(withBaseUrl(baseUrl, `/wait/download${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 60000,
  });
}
