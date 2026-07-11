/**
 * Snapshot, navigation, close, and PDF helpers for Playwright-backed
 * browser tools.
 */
import { parseFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import type { BrowserDownloadResult } from "./download-types.js";
import {
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  assertBrowserDownloadSaveAllowed,
  createAbortPromiseWithListener,
  runGuardedPlaywrightPageAction,
} from "./pw-interaction-navigation-guard.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId as getPageForTargetIdBase,
  gotoPageWithNavigationGuard,
  isBrowserObservedDialogBlockedError,
  isDownloadStartingNavigationError,
  isPolicyDenyNavigationError,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import { markBackendDomRefsOnPage, withPageScopedCdpClient } from "./pw-session.page-cdp.js";
import {
  collectSnapshotUrlsOnPage,
  resolveSnapshotTimeoutMs,
  snapshotRoleOnPageViaPlaywright,
  type RoleSnapshotResult,
} from "./pw-tools-core.snapshot-page.js";
import { appendSnapshotUrls } from "./snapshot-urls.js";

function getPageForTargetId(
  opts: { cdpUrl: string; targetId?: string } & BrowserNavigationPolicyOptions,
) {
  return getPageForTargetIdBase({
    ...opts,
    pageNavigationPolicy: withBrowserNavigationPolicy(opts.ssrfPolicy, {
      browserProxyMode: opts.browserProxyMode,
    }),
  });
}

function resolveBoundedTimeoutMs(
  timeoutMs: number | undefined,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(minMs, Math.min(maxMs, Math.floor(parsed ?? fallbackMs)));
}

function resolveNavigationTimeoutMs(timeoutMs: number | undefined): number {
  return resolveBoundedTimeoutMs(timeoutMs, 20_000, 1000, 120_000);
}

function buildStoredAriaRefs(
  nodes: AriaSnapshotNode[],
  markedRefs: Set<string>,
): Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }> {
  const refs: Record<string, { role: string; name?: string; nth?: number; domMarker?: boolean }> =
    {};
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();

  for (const node of nodes) {
    const role = normalizeLowercaseStringOrEmpty(node.role) || "unknown";
    const name = node.name.trim() || undefined;
    const key = `${role}:${name ?? ""}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const refsForKey = refsByKey.get(key);
    if (refsForKey) {
      refsForKey.push(node.ref);
    } else {
      refsByKey.set(key, [node.ref]);
    }
    refs[node.ref] = {
      role,
      ...(name ? { name } : {}),
      ...(nth > 0 ? { nth } : {}),
      ...(markedRefs.has(node.ref) ? { domMarker: true } : {}),
    };
  }

  for (const refsForKey of refsByKey.values()) {
    if (refsForKey.length > 1) {
      continue;
    }
    const ref = refsForKey[0];
    if (ref) {
      delete refs[ref]?.nth;
    }
  }

  return refs;
}

type GuardedSnapshotOptions = {
  cdpUrl: string;
  targetId?: string;
  signal?: AbortSignal;
} & BrowserNavigationPolicyOptions;

async function resolveSnapshotPageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  return page;
}

async function storeAriaSnapshotRefsOnPage(opts: {
  cdpUrl: string;
  targetId?: string;
  nodes: AriaSnapshotNode[];
  page: Page;
}): Promise<void> {
  const markedRefs = await markBackendDomRefsOnPage({
    page: opts.page,
    refs: opts.nodes.flatMap((node) =>
      typeof node.backendDOMNodeId === "number"
        ? [{ ref: node.ref, backendDOMNodeId: node.backendDOMNodeId }]
        : [],
    ),
  });
  storeRoleRefsForTarget({
    page: opts.page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: buildStoredAriaRefs(opts.nodes, markedRefs),
    mode: "role",
  });
}

/** Stores aria snapshot refs so later tool calls can resolve stable element refs. */
export async function storeAriaSnapshotRefsViaPlaywright(
  opts: GuardedSnapshotOptions & { nodes: AriaSnapshotNode[] },
): Promise<void> {
  const page = await resolveSnapshotPageViaPlaywright(opts);
  await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => await storeAriaSnapshotRefsOnPage({ ...opts, page }),
  });
}

/** Captures a raw accessibility tree snapshot and stores matching role refs. */
export async function snapshotAriaViaPlaywright(
  opts: GuardedSnapshotOptions & {
    limit?: number;
    timeoutMs?: number;
  },
): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = resolveIntegerOption(opts.limit, 500, { min: 1, max: 2000 });
  const page = await resolveSnapshotPageViaPlaywright(opts);
  const ariaTimeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => {
      const collectAxTree = withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Accessibility.enable").catch(() => {});
          return (await send("Accessibility.getFullAXTree")) as {
            nodes?: RawAXNode[];
          };
        },
      });
      void collectAxTree.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new AbortController();
      const timeoutError = new Error(
        `Aria snapshot via Playwright timed out after ${ariaTimeoutMs}ms.`,
      );
      timer = setTimeout(() => {
        deadline.abort(timeoutError);
      }, ariaTimeoutMs);
      timer.unref?.();
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, deadline.signal])
        : deadline.signal;
      const { abortPromise, cleanup } = createAbortPromiseWithListener(signal, () => {
        // CDPSession.send has no cancellation API. Retire the cached connection
        // before returning so a stuck AX command cannot retain the page guard.
        void forceDisconnectPlaywrightForTarget({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          ssrfPolicy: opts.ssrfPolicy,
          reason: "aria snapshot interrupted",
        }).catch(() => {});
      });
      const collectResult = abortPromise
        ? Promise.race([collectAxTree, abortPromise])
        : collectAxTree;
      let res: { nodes?: RawAXNode[] };
      try {
        res = (await collectResult) as { nodes?: RawAXNode[] };
      } finally {
        cleanup();
        if (timer) {
          clearTimeout(timer);
        }
      }
      const nodes = Array.isArray(res.nodes) ? res.nodes : [];
      const formatted = formatAriaSnapshot(nodes, limit);
      await storeAriaSnapshotRefsOnPage({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        nodes: formatted,
        page,
      });
      return { nodes: formatted };
    },
  });
}

/** Captures Playwright's AI aria snapshot with optional URL appendix and truncation. */
export async function snapshotAiViaPlaywright(
  opts: GuardedSnapshotOptions & {
    timeoutMs?: number;
    maxChars?: number;
    urls?: boolean;
  },
): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  const page = await resolveSnapshotPageViaPlaywright(opts);
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () => {
      let snapshot = await page.ariaSnapshot({
        mode: "ai",
        timeout: resolveSnapshotTimeoutMs(opts.timeoutMs),
      });
      if (opts.urls) {
        snapshot = appendSnapshotUrls(snapshot, await collectSnapshotUrlsOnPage(page));
      }
      const maxChars = opts.maxChars;
      const limit =
        typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
          ? Math.floor(maxChars)
          : undefined;
      let truncated = false;
      if (limit && snapshot.length > limit) {
        snapshot = `${truncateUtf16Safe(snapshot, limit)}\n\n[...TRUNCATED - page too large]`;
        truncated = true;
      }

      const built = buildRoleSnapshotFromAiSnapshot(snapshot);
      storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: built.refs,
        mode: "aria",
      });
      return truncated ? { snapshot, truncated, refs: built.refs } : { snapshot, refs: built.refs };
    },
  });
}

/** Captures a role-ref snapshot used by model-facing browser interaction tools. */
export async function snapshotRoleViaPlaywright(
  opts: GuardedSnapshotOptions & {
    selector?: string;
    frameSelector?: string;
    refsMode?: "role" | "aria";
    options?: RoleSnapshotOptions;
    urls?: boolean;
    timeoutMs?: number;
  },
): Promise<RoleSnapshotResult> {
  const page = await resolveSnapshotPageViaPlaywright(opts);
  return await runGuardedPlaywrightPageAction({
    ...opts,
    page,
    action: async () =>
      await snapshotRoleOnPageViaPlaywright({
        ...opts,
        page,
      }),
  });
}

/** Navigates the target page while enforcing browser SSRF policy before and after load. */
export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<{ url: string; download?: BrowserDownloadResult }> {
  const isRetryableNavigateError = (err: unknown): boolean => {
    const msg =
      typeof err === "string"
        ? err.toLowerCase()
        : err instanceof Error
          ? err.message.toLowerCase()
          : "";
    return (
      msg.includes("frame has been detached") ||
      msg.includes("target page, context or browser has been closed")
    );
  };

  const url = normalizeOptionalString(opts.url) ?? "";
  if (!url) {
    throw new Error("url is required");
  }
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  await assertBrowserNavigationAllowed({
    url,
    ...navigationPolicy,
  });
  const timeout = resolveNavigationTimeoutMs(opts.timeoutMs);
  let page = await getPageForTargetId(opts);
  let pageState = ensurePageState(page);
  const navigate = async () =>
    await gotoPageWithNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page,
      url,
      timeoutMs: timeout,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      targetId: opts.targetId,
    });
  const navigateWithDownloadCapture = async (): Promise<{
    response: Awaited<ReturnType<typeof navigate>> | null;
    download?: BrowserDownloadResult;
  }> => {
    const downloadCapture = createDownloadCaptureForPage(page, pageState, timeout, {
      mode: "passive",
      timeoutMessage: "Timeout waiting for navigation download",
      beforeSave: async (download) => {
        await assertBrowserDownloadSaveAllowed({
          downloadUrl: download.url || url,
          page,
          ssrfPolicy: opts.ssrfPolicy,
          browserProxyMode: opts.browserProxyMode,
        });
      },
    });
    void downloadCapture.promise.catch(() => {});
    try {
      const response = await navigate();
      downloadCapture.cancel();
      return { response };
    } catch (err) {
      if (!isDownloadStartingNavigationError(err, url) || !downloadCapture.armed) {
        downloadCapture.cancel();
        throw err;
      }
      try {
        return { response: null, download: await downloadCapture.promise };
      } catch (downloadErr) {
        if (
          downloadErr instanceof Error &&
          downloadErr.message === "Timeout waiting for navigation download"
        ) {
          throw err;
        }
        if (isPolicyDenyNavigationError(downloadErr)) {
          await closeBlockedNavigationTarget({
            cdpUrl: opts.cdpUrl,
            page,
            targetId: opts.targetId,
          });
        }
        throw downloadErr;
      }
    }
  };

  let navigationResult: Awaited<ReturnType<typeof navigateWithDownloadCapture>>;
  try {
    navigationResult = await navigateWithDownloadCapture();
  } catch (err) {
    if (!isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "retry navigate after detached frame",
    }).catch(() => {});
    page = await getPageForTargetId(opts);
    pageState = ensurePageState(page);
    navigationResult = await navigateWithDownloadCapture();
  }
  try {
    if (!navigationResult.download) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: navigationResult.response,
        ssrfPolicy: opts.ssrfPolicy,
        browserProxyMode: opts.browserProxyMode,
        targetId: opts.targetId,
      });
    }
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
      });
    }
    throw err;
  }
  const finalUrl = navigationResult.download?.url || page.url();
  return {
    url: finalUrl,
    ...(navigationResult.download ? { download: navigationResult.download } : {}),
  };
}

/** Closes the target Playwright page. */
export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

/** Renders the target page to a PDF buffer. */
export async function pdfViaPlaywright(opts: GuardedSnapshotOptions): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const { cleanup } = createAbortPromiseWithListener(opts.signal, (reason) => {
    if (isBrowserObservedDialogBlockedError(reason)) {
      return;
    }
    // Chromium does not expose a timeout for Page.printToPDF. Retire the
    // connection so an aborted beforeprint hook cannot strand the page guard.
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      reason: "pdf generation aborted",
    }).catch(() => {});
  });
  try {
    return await runGuardedPlaywrightPageAction({
      ...opts,
      page,
      action: async () => ({ buffer: await page.pdf({ printBackground: true }) }),
    });
  } finally {
    cleanup();
  }
}
