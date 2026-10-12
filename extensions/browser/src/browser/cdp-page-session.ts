/**
 * CDP page-session preparation and committed-navigation observation.
 */
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";
import type { CdpProtocolSend } from "./cdp-ax.js";
import { assertCdpEndpointAllowed, type CdpSendFn, withCdpSocket } from "./cdp.helpers.js";
import { BrowserError, BrowserNativePolicyBlockedError } from "./errors.js";

/** HTTP and WebSocket timeout options for CDP actions that need discovery. */
export type CdpActionTimeouts = {
  httpTimeoutMs?: number;
  handshakeTimeoutMs?: number;
};

const CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS = 2_000;
const CDP_TARGET_NAVIGATION_RESULT_POLL_MS = 50;
const CDP_TARGET_NAVIGATION_STABILITY_MS = 250;

type CdpGetFrameTreeSend = (
  method: "Page.getFrameTree",
  params?: undefined,
  sessionId?: string,
) => Promise<unknown>;

type CdpFrameTree = {
  frame?: {
    id?: unknown;
    loaderId?: unknown;
    unreachableUrl?: unknown;
    url?: unknown;
    urlFragment?: unknown;
  };
  childFrames?: CdpFrameTree[];
};

type CdpFrameTreeResult = {
  frameTree?: CdpFrameTree;
};

export type CdpDocumentIdentities = {
  mainFrame?: string;
  frameTree?: string;
};

const nativeNavigationErrorSchema = z.object({
  result: z.object({
    value: z.object({ code: z.string(), summary: z.string() }),
  }),
});

const nativeNavigationFrameSchema = z.object({
  frameTree: z
    .object({
      frame: z
        .object({
          id: z.string().optional(),
          loaderId: z.string().optional(),
          url: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

async function assertCdpFrameNavigationSucceeded(
  send: CdpProtocolSend,
  frame: CdpFrameTree["frame"],
  sessionId?: string,
): Promise<void> {
  if (frame?.url !== "chrome-error://chromewebdata/") {
    return;
  }
  // This document is Chromium-owned. Ordinary websites cannot supply the
  // authoritative error URL, even if they copy its HTML or loadTimeDataRaw.
  const native = nativeNavigationErrorSchema.safeParse(
    await send(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const data = globalThis.loadTimeDataRaw;
        const summary = document.createElement('div');
        summary.innerHTML = typeof data?.summary?.msg === 'string' ? data.summary.msg : '';
        return {
          code: typeof data?.errorCode === 'string' ? data.errorCode : '',
          summary: (summary.textContent || '').slice(0, 800)
        };
      })()`,
        returnByValue: true,
      },
      sessionId,
    ),
  );
  const current = nativeNavigationFrameSchema.parse(
    await send("Page.getFrameTree", undefined, sessionId),
  );
  const currentFrame = current.frameTree?.frame;
  if (currentFrame?.url !== "chrome-error://chromewebdata/") {
    return;
  }
  // A concurrent navigation can replace the error document while evaluation
  // awaits. Trust its text only while the browser still reports the same loader.
  const sameDocument =
    typeof frame.id === "string" &&
    typeof frame.loaderId === "string" &&
    currentFrame.id === frame.id &&
    currentFrame.loaderId === frame.loaderId;
  const detail = native.success && sameDocument ? native.data.result.value : undefined;
  if (detail?.code === "ERR_BLOCKED_BY_ADMINISTRATOR") {
    throw new BrowserNativePolicyBlockedError("navigation");
  }
  const code =
    detail?.code && /^ERR_[A-Z0-9_]+$/.test(detail.code)
      ? `net::${truncateUtf16Safe(detail.code, 100)}. `
      : "";
  const summary = detail?.summary
    ? truncateUtf16Safe(redactToolPayloadText(stripVTControlCharacters(detail.summary)), 800)
    : "The browser committed a navigation error page.";
  throw new BrowserError(
    `${code}Chromium could not load this page. Browser reported: ${summary}. Inspect this tab and chrome://policy if your organization restricts access.`,
    400,
  );
}

/** Report a committed native browser error without interpreting policy URL patterns. */
export async function assertCdpNavigationSucceeded(send: CdpProtocolSend): Promise<void> {
  const result = nativeNavigationFrameSchema.parse(await send("Page.getFrameTree"));
  await assertCdpFrameNavigationSucceeded(send, result.frameTree?.frame);
}

function readCommittedFrameUrl(
  frame: NonNullable<CdpFrameTreeResult["frameTree"]>["frame"],
): string | undefined {
  const unreachableUrl =
    typeof frame?.unreachableUrl === "string" ? frame.unreachableUrl.trim() : "";
  if (unreachableUrl) {
    return unreachableUrl;
  }
  const url = typeof frame?.url === "string" ? frame.url.trim() : "";
  // Chrome reports ":" for the initial empty document before navigation commits.
  if (url === ":") {
    return undefined;
  }
  const fragment = typeof frame?.urlFragment === "string" ? frame.urlFragment.trim() : "";
  return url ? `${url}${fragment}` : undefined;
}

/** Read committed document identities together so snapshot facts share one browser observation. */
export async function readCdpDocumentIdentities(
  send: CdpGetFrameTreeSend,
  sessionId?: string,
): Promise<CdpDocumentIdentities> {
  const result = (await send("Page.getFrameTree", undefined, sessionId).catch(
    () => null,
  )) as CdpFrameTreeResult | null;
  const root = result?.frameTree;
  const loaderId = root?.frame?.loaderId;
  const identities: CdpDocumentIdentities = {
    mainFrame:
      typeof loaderId === "string" && loaderId.trim() ? `cdp:${loaderId.trim()}` : undefined,
  };
  const pending = root ? [root] : [];
  const documents: [string, string][] = [];
  while (pending.length) {
    const node = pending.pop()!;
    const id = node.frame?.id;
    const loader = node.frame?.loaderId;
    if (typeof id !== "string" || !id.trim() || typeof loader !== "string" || !loader.trim()) {
      return identities;
    }
    documents.push([id.trim(), loader.trim()]);
    for (const child of node.childFrames ?? []) {
      pending.push(child);
    }
  }
  if (documents.length) {
    documents.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    identities.frameTree = `cdp-tree:${createHash("sha256").update(JSON.stringify(documents)).digest("hex")}`;
  }
  return identities;
}

async function waitForCdpNavigationResult(
  send: CdpSendFn,
  sessionId: string | undefined,
  requestedUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS;
  const requestedAboutBlank = requestedUrl.trim() === "" || requestedUrl.trim() === "about:blank";
  let stableCandidate: { key: string; since: number } | undefined;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const frameTree = await send("Page.getFrameTree", undefined, sessionId).catch(() => null);
    signal?.throwIfAborted();
    const frame = (frameTree as CdpFrameTreeResult | null)?.frameTree?.frame;
    const finalUrl = readCommittedFrameUrl(frame);
    if (requestedAboutBlank && finalUrl === "about:blank") {
      return finalUrl;
    }
    const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId.trim() : "";
    // Page.getFrameTree is browser-owned: its main frame URL and loader id
    // describe the currently committed document, not a provisional request or
    // page-overridable JavaScript value. A short stable window catches immediate
    // client redirects without waiting for slow subresources to finish loading.
    if (finalUrl && finalUrl !== "about:blank" && loaderId) {
      const key = `${loaderId}\n${finalUrl}`;
      const now = Date.now();
      if (stableCandidate?.key === key) {
        if (now - stableCandidate.since >= CDP_TARGET_NAVIGATION_STABILITY_MS) {
          await assertCdpFrameNavigationSucceeded(send, frame, sessionId);
          return finalUrl;
        }
      } else {
        stableCandidate = { key, since: now };
      }
    } else {
      stableCandidate = undefined;
    }
    await sleepWithAbort(CDP_TARGET_NAVIGATION_RESULT_POLL_MS);
  }
  return undefined;
}

/** Enable the page domains shared by target preparation and page operations. */
export async function prepareCdpPageSession(
  send: CdpProtocolSend,
  sessionId?: string,
): Promise<void> {
  await Promise.all([
    send("Page.enable", undefined, sessionId).catch(() => {}),
    send("Runtime.enable", undefined, sessionId).catch(() => {}),
    send("Network.enable", undefined, sessionId).catch(() => {}),
    send("DOM.enable", undefined, sessionId).catch(() => {}),
    send("Accessibility.enable", undefined, sessionId).catch(() => {}),
  ]);
  await send("Runtime.runIfWaitingForDebugger", undefined, sessionId).catch(() => {});
}

/** Prepare a created target and optionally observe its committed document URL. */
export async function prepareCdpTargetSession(
  send: CdpSendFn,
  targetId: string,
  navigationUrl?: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const attached = (await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  }).catch(() => null)) as { sessionId?: unknown } | null;
  const sessionId = typeof attached?.sessionId === "string" ? attached.sessionId : undefined;
  if (!sessionId) {
    return undefined;
  }
  try {
    await prepareCdpPageSession(send, sessionId);
    return navigationUrl === undefined
      ? undefined
      : await waitForCdpNavigationResult(send, sessionId, navigationUrl, signal);
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}

/** Read the committed document URL from a page-level CDP WebSocket. */
export async function waitForCdpCommittedNavigationUrl(opts: {
  wsUrl: string;
  configuredCdpUrl: string;
  cdpPolicy?: SsrFPolicy;
  requestedUrl: string;
  signal?: AbortSignal;
  timeouts?: CdpActionTimeouts;
}): Promise<string | undefined> {
  const pinned = await assertCdpEndpointAllowed(opts.wsUrl, opts.cdpPolicy, {
    source: "discovered",
    configuredUrl: opts.configuredCdpUrl,
  });
  opts.signal?.throwIfAborted();
  try {
    return await withCdpSocket(
      opts.wsUrl,
      async (send) => {
        opts.signal?.throwIfAborted();
        await send("Page.enable");
        return await waitForCdpNavigationResult(send, undefined, opts.requestedUrl, opts.signal);
      },
      {
        commandTimeoutMs: opts.timeouts?.httpTimeoutMs ?? CDP_TARGET_NAVIGATION_RESULT_TIMEOUT_MS,
        handshakeTimeoutMs: opts.timeouts?.handshakeTimeoutMs,
        handshakeRetries: 0,
        lookup: pinned?.lookup,
      },
    );
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (error instanceof BrowserError) {
      throw error;
    }
    return undefined;
  }
}
