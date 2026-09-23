/**
 * Snapshot, navigation, viewport, close, and PDF helpers for Playwright-backed
 * browser tools.
 */
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { ACT_MAX_VIEWPORT_DIMENSION, resolveBrowserNavigationTimeoutMs } from "./act-policy.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import type { BrowserDownloadResult } from "./download-types.js";
import { BrowserTabNotFoundError } from "./errors.js";
import type { RelayOperationReference } from "./extension-relay/owner-client.js";
import { closeRelayOperationConnection } from "./extension-relay/owner-playwright.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  type BrowserNavigationPolicyOptions,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { createDownloadCaptureForPage } from "./pw-download-capture.js";
import type { RoleRefMap } from "./pw-role-snapshot.js";
import {
  closeConnectionScopedPageBrowser,
  connectBrowser,
  pageTargetInfo,
} from "./pw-session-connection.js";
import type { RoleRefs } from "./pw-session-contracts.js";
import { isConnectionScopedPage } from "./pw-session-page-target.js";
import {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError,
  isPolicyDenyNavigationError,
  storeRoleRefsForTarget,
} from "./pw-session.js";
import {
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
} from "./pw-session.page-cdp.js";
import {
  prepareSnapshotPageViaPlaywright,
  resolveSnapshotTimeoutMs,
  withSnapshotFrameGuard,
} from "./pw-snapshot-page.js";
import {
  assertInteractionCurrent,
  type InteractionTargetOptions,
} from "./pw-tools-core.interactions.navigation.js";
import { runPageEmulationTransition, setViewportSizeOnPage } from "./pw-tools-core.state.js";
import {
  assertBrowserDashboardTabCanClose,
  readBrowserDashboardTabs,
} from "./session-tab-store.js";
export { snapshotRoleViaPlaywright } from "./pw-role-snapshot-capture.js";

type StoredSnapshotRef = RoleRefs[string] & { backendDOMNodeId?: number };

function resolveViewportDimension(value: unknown, label: "width" | "height"): number {
  const dimension = resolveIntegerOption(value, 1, { min: 1 });
  if (dimension > ACT_MAX_VIEWPORT_DIMENSION) {
    throw new Error(`viewport ${label} exceeds maximum of ${ACT_MAX_VIEWPORT_DIMENSION}`);
  }
  return dimension;
}

function buildStoredAriaRefs(nodes: AriaSnapshotNode[]): Record<string, StoredSnapshotRef> {
  const refs: Record<string, StoredSnapshotRef> = {};
  const groups = new Map<string, { count: number; firstRef: string }>();

  for (const node of nodes) {
    const role = normalizeLowercaseStringOrEmpty(node.role) || "unknown";
    const name = node.name.trim();
    const key = `${role}:${name}`;
    const group = groups.get(key);
    const nth = group?.count ?? 0;
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { count: 1, firstRef: node.ref });
    }
    refs[node.ref] = {
      role,
      name,
      // Keep index zero for duplicates; only singleton groups can omit nth.
      nth,
      ...(typeof node.backendDOMNodeId === "number"
        ? { backendDOMNodeId: node.backendDOMNodeId }
        : {}),
    };
  }

  // Resolve by ref after grouping: later input nodes can overwrite the same ref.
  for (const { count, firstRef } of groups.values()) {
    if (count === 1 && firstRef) {
      delete refs[firstRef]?.nth;
    }
  }

  return refs;
}

/** Publish raw or finalized snapshot refs into the Playwright action cache. */
export async function storeSnapshotRefsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  page?: Page;
  nodes?: AriaSnapshotNode[];
  refs?: Record<string, StoredSnapshotRef>;
  expectedDocumentIdentity?: string;
  signal?: AbortSignal;
  deadlineMs?: number;
  assertCurrent?: () => void;
}): Promise<void> {
  const sourceRefs = opts.refs ?? buildStoredAriaRefs(opts.nodes ?? []);
  const page =
    opts.page ??
    (await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    }));
  ensurePageState(page);
  const backendRefs: { ref: string; backendDOMNodeId: number }[] = [];
  for (const [ref, info] of Object.entries(sourceRefs)) {
    if (typeof info.backendDOMNodeId === "number") {
      backendRefs.push({ ref, backendDOMNodeId: info.backendDOMNodeId });
    }
  }
  await withSnapshotFrameGuard({
    page,
    frame: page.mainFrame(),
    signal: opts.signal,
    deadlineMs: opts.deadlineMs,
    assertCurrent: opts.assertCurrent,
    run: async (assertCurrent) => {
      if (
        opts.expectedDocumentIdentity &&
        (await readMainFrameDocumentIdentityForPage(page)) !== opts.expectedDocumentIdentity
      ) {
        throw new Error(
          "Frame changed while its browser snapshot refs were being published; retry.",
        );
      }
      await markBackendDomRefsOnPage({ page, refs: backendRefs, assertCurrent });
      assertCurrent();
      const refs: RoleRefMap = Object.fromEntries(
        Object.entries(sourceRefs).map(([ref, info]) => {
          const { backendDOMNodeId, ...storedInfo } = info;
          // A lost DOM binding must not retarget the ref by role/name order.
          if (typeof backendDOMNodeId === "number") {
            storedInfo.domMarker = true;
          }
          return [ref, storedInfo];
        }),
      );
      storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs,
        mode: "role",
      });
    },
  });
}

/** Captures a raw accessibility tree snapshot and stores matching role refs. */
export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = resolveIntegerOption(opts.limit, 500, { min: 1, max: 2000 });
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  const ariaTimeoutMs = resolveSnapshotTimeoutMs(opts.timeoutMs);
  return await withSnapshotFrameGuard({
    page,
    frame: page.mainFrame(),
    signal: opts.signal,
    deadlineMs: performance.now() + ariaTimeoutMs,
    run: async (assertCurrent) => {
      const res = await withPageScopedCdpClient({
        page,
        timeoutMs: ariaTimeoutMs,
        fn: async (send) => {
          await send("Accessibility.enable").catch(() => {});
          return (await send("Accessibility.getFullAXTree")) as { nodes?: RawAXNode[] };
        },
      });
      assertCurrent();
      const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
      const formatted = formatAriaSnapshot(nodes, limit);
      await storeSnapshotRefsViaPlaywright({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        nodes: formatted,
        page,
        signal: opts.signal,
        assertCurrent,
      });
      return { nodes: formatted };
    },
  });
}

/** Navigates the target page while enforcing browser SSRF policy before and after load. */
export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  assertCurrent?: InteractionTargetOptions["assertCurrent"];
  resolveOperationTarget?: () => string | undefined | Promise<string | undefined>;
  relayReference?: RelayOperationReference;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationPolicyOptions["browserProxyMode"];
}): Promise<{ url: string; targetId?: string; download?: BrowserDownloadResult }> {
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
  const timeout = resolveBrowserNavigationTimeoutMs(opts.timeoutMs);
  let currentTargetId = opts.targetId;
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
      targetId: currentTargetId,
      ...(opts.resolveOperationTarget
        ? {
            assertPageCurrent: async () => {
              if ((await opts.resolveOperationTarget?.()) !== currentTargetId) {
                throw new BrowserTabNotFoundError({ input: currentTargetId });
              }
              if (opts.assertCurrent) {
                await opts.assertCurrent();
              }
            },
          }
        : opts.assertCurrent
          ? { assertPageCurrent: opts.assertCurrent }
          : {}),
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
            targetId: currentTargetId,
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
    if (isConnectionScopedPage(page) || !isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    if (opts.relayReference) {
      await closeRelayOperationConnection(opts.relayReference);
    } else {
      await forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        ssrfPolicy: opts.ssrfPolicy,
      }).catch(() => {});
    }
    if (opts.resolveOperationTarget) {
      // Auto-attach completes during reconnect; only then can the same tab owner prove its new ID.
      await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, opts.relayReference);
      const replacementTargetId = await opts.resolveOperationTarget();
      if (!replacementTargetId) {
        throw new BrowserTabNotFoundError({ input: currentTargetId });
      }
      page = await getPageForTargetId({ ...opts, targetId: replacementTargetId });
      if ((await opts.resolveOperationTarget()) !== replacementTargetId) {
        throw new BrowserTabNotFoundError({ input: currentTargetId });
      }
      currentTargetId = replacementTargetId;
    } else {
      page = await getPageForTargetId(opts);
    }
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
        targetId: currentTargetId,
      });
    }
  } catch (err) {
    if (isPolicyDenyNavigationError(err)) {
      await closeBlockedNavigationTarget({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: currentTargetId,
      });
    }
    throw err;
  }
  const finalUrl = navigationResult.download?.url || page.url();
  const targetId = (await pageTargetInfo(page).catch(() => null))?.targetId;
  return {
    url: finalUrl,
    ...(targetId ? { targetId } : {}),
    ...(navigationResult.download ? { download: navigationResult.download } : {}),
  };
}

/** Resizes the target page viewport within the browser action policy bounds. */
export async function resizeViewportViaPlaywright(
  opts: InteractionTargetOptions & {
    width: number;
    height: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const viewport = {
    width: resolveViewportDimension(opts.width, "width"),
    height: resolveViewportDimension(opts.height, "height"),
  };
  await runPageEmulationTransition({
    state,
    signal: opts.signal,
    run: opts.assertCurrent
      ? async () => {
          await assertInteractionCurrent(opts);
          opts.signal?.throwIfAborted();
          await setViewportSizeOnPage(page, state, viewport);
        }
      : () => setViewportSizeOnPage(page, state, viewport),
  });
}

/** Closes the target Playwright page. */
export async function closePageViaPlaywright(opts: InteractionTargetOptions): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (readBrowserDashboardTabs().length > 0) {
    const targetId = (await pageTargetInfo(page))?.targetId;
    if (!targetId) {
      throw new Error("Cannot verify that this page is not retained by a dashboard");
    }
    assertBrowserDashboardTabCanClose(targetId);
  }
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  if (isConnectionScopedPage(page)) {
    const browser = page.context().browser();
    if (browser) {
      await closeConnectionScopedPageBrowser(opts.cdpUrl, browser);
    }
  } else {
    await page.close();
  }
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
