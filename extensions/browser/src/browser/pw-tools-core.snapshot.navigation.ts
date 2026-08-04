/** Navigation, viewport, close, and PDF helpers for Playwright-backed browser tools. */
import { parseFiniteNumber, resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./act-policy.js";
import type { BrowserDownloadResult } from "./download-types.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError,
  isPolicyDenyNavigationError,
} from "./pw-session.js";

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

function resolveViewportDimension(value: unknown, label: "width" | "height"): number {
  const dimension = resolveIntegerOption(value, 1, { min: 1 });
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new Error(`viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`);
  }
  return dimension;
}

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
        await assertBrowserNavigationResultAllowed({
          url: download.url || url,
          ...navigationPolicy,
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

/** Resizes the target page viewport within the browser action policy bounds. */
export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    width: resolveViewportDimension(opts.width, "width"),
    height: resolveViewportDimension(opts.height, "height"),
  });
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
export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
