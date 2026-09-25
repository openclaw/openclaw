import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Browser, Page, Response } from "playwright-core";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  normalizeCdpHttpBaseForJsonEndpoints,
  scopeCdpPolicyToConfiguredEndpoint,
  withCdpSocket,
} from "./cdp.helpers.js";
import { AX_REF_PATTERN, normalizeCdpWsUrl } from "./cdp.js";
import { DEFAULT_BROWSER_ACTION_TIMEOUT_MS } from "./constants.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserEngineId } from "./engines/types.js";
import {
  withBrowserNavigationPolicy,
  assertBrowserNavigationAllowed,
  type BrowserNavigationPolicyOptions,
} from "./navigation-guard.js";
import {
  clearBlockedPageRef,
  clearBlockedPageRefsForCdpUrl,
  clearBlockedTarget,
  closeConnectionScopedPageBrowser,
  clearBlockedTargetsForCdpUrl,
  connectBrowser,
  evictStalePlaywrightBrowserConnection,
  getAllPages,
  getPageForTargetId,
  isBlockedPageRef,
  isBlockedTarget,
  isRecoverablePlaywrightDisconnectError,
  pageTargetInfo,
  retirePlaywrightBrowserConnectionExact,
  ensureContextState,
} from "./pw-session-connection.js";
import {
  cachedByCdpUrl,
  connectingByCdpUrl,
  pageStates,
  retainedClosingByCdpUrl,
  type BrowserObservedState,
} from "./pw-session-contracts.js";
import {
  assertPageNavigationCompletedSafely,
  gotoPageWithNavigationGuard,
  isPolicyDenyNavigationError,
} from "./pw-session-navigation.js";
import { isConnectionScopedPage } from "./pw-session-page-target.js";
import type { PlaywrightOwnedPage } from "./pw-session-page.types.js";
import {
  ensurePageState,
  getObservedBrowserStateForPage,
  normalizeCdpUrl,
} from "./pw-session-state.js";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  readDocumentIdentitiesForPage,
} from "./pw-session.page-cdp.js";
import {
  assertBrowserDashboardTabCanClose,
  readBrowserDashboardTabs,
} from "./session-tab-store.js";

export async function getObservedBrowserStateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<BrowserObservedState> {
  const page = await getPageForTargetId(opts);
  return getObservedBrowserStateForPage(page);
}

/** Resolve a page and read its committed document identities. */
export async function getDocumentIdentitiesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
}) {
  const page = await getPageForTargetId(opts);
  return await readDocumentIdentitiesForPage(page, opts.timeoutMs);
}

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  const isRoleRef = /^e\d+$/.test(normalized);
  if (isRoleRef || AX_REF_PATTERN.test(normalized)) {
    const state = pageStates.get(page);
    if (isRoleRef && state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrame ?? page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrame ?? page;
    if (info.domMarker) {
      return scope.locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}="${normalized}"]`);
    }
    // Playwright omits empty names and names over 900 UTF-16 units from ARIA text.
    // Match that exact bucket before nth; raw AX names (including "") stay explicit.
    const locator = scope.getByRole(info.role as never, {
      name: info.name ?? /^$|^.{901,}$/s,
      exact: true,
    });
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

/** Close one or all cached Playwright browser connections. */
export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;

  if (normalized) {
    await retirePlaywrightBrowserConnectionExact({ cdpUrl: normalized }).close();
    return;
  }

  const cdpUrls = new Set([
    ...cachedByCdpUrl.keys(),
    ...connectingByCdpUrl.keys(),
    ...retainedClosingByCdpUrl.keys(),
  ]);
  clearBlockedTargetsForCdpUrl();
  clearBlockedPageRefsForCdpUrl();
  const results = await Promise.allSettled(
    [...cdpUrls].map(
      async (cdpUrl) => await retirePlaywrightBrowserConnectionExact({ cdpUrl }).close(),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
}

function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/")
    );
  } catch {
    return false;
  }
}

async function tryTerminateExecutionViaCdp(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
  isCurrent: () => boolean;
}): Promise<void> {
  await assertCdpEndpointAllowed(opts.cdpUrl, opts.ssrfPolicy);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(opts.cdpUrl, opts.ssrfPolicy);
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000, undefined, cdpControlPolicy).catch(() => null);
  if (!pages || pages.length === 0 || !opts.isCurrent()) {
    return;
  }

  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  const target = pages.find((p) => normalizeOptionalString(p.id) === targetId);
  const wsUrlRaw = normalizeOptionalString(target?.webSocketDebuggerUrl) ?? "";
  if (!wsUrlRaw) {
    return;
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
  const wsPin = await assertCdpEndpointAllowed(wsUrl, cdpControlPolicy, {
    source: "discovered",
    configuredUrl: opts.cdpUrl,
  });
  const needsAttach = cdpSocketNeedsAttach(wsUrl);
  if (!opts.isCurrent()) {
    return;
  }

  await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      try {
        if (needsAttach) {
          const attached = (await send("Target.attachToTarget", {
            targetId: opts.targetId,
            flatten: true,
          })) as { sessionId?: unknown };
          sessionId = normalizeOptionalString(attached?.sessionId);
        }
        if (opts.isCurrent()) {
          await send("Runtime.terminateExecution", undefined, sessionId);
        }
        if (sessionId) {
          // Best-effort cleanup; not required for termination to take effect.
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      } catch {
        // Best-effort; ignore
      }
    },
    { handshakeTimeoutMs: 2000, commandTimeoutMs: 1500, lookup: wsPin?.lookup },
  ).catch(() => {});
}

// Closing Playwright's shared Connection would prevent later reconnects. Retire
// only this browser adapter, and let the next action establish a fresh CDP socket.
/** Force-disconnect a Playwright connection to unblock a stuck target operation. */
export async function forceDisconnectPlaywrightForTarget(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const browser = opts.page.context().browser();
  const cur = cachedByCdpUrl.get(normalized);
  if (!browser || cur?.browser !== browser) {
    return;
  }

  // Best-effort: kill any stuck JS to unblock the target's execution context before we
  // disconnect Playwright's CDP connection.
  const targetId = normalizeOptionalString(opts.targetId) ?? "";
  if (targetId) {
    await tryTerminateExecutionViaCdp({
      cdpUrl: normalized,
      targetId,
      ssrfPolicy: opts.ssrfPolicy,
      isCurrent: () => cachedByCdpUrl.get(normalized) === cur,
    }).catch(() => {});
  }

  // Fire-and-forget: don't await because browser.close() may hang on the stuck CDP pipe.
  evictStalePlaywrightBrowserConnection(normalized, browser);
}

async function withPlaywrightSafeReadReconnect<T>(
  opts: {
    cdpUrl: string;
    engine?: BrowserEngineId;
    ssrfPolicy?: SsrFPolicy;
    signal: AbortSignal;
  },
  run: (browser: Browser) => Promise<T>,
): Promise<T> {
  const connected = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, undefined, opts.engine);
  try {
    return await run(connected.browser);
  } catch (err) {
    if (
      !resolveBrowserEngine(connected.engine).canReconnectForSafeReads ||
      !isRecoverablePlaywrightDisconnectError(err) ||
      opts.signal.aborted
    ) {
      throw err;
    }
    evictStalePlaywrightBrowserConnection(opts.cdpUrl, connected.browser);
    if (opts.signal.aborted) {
      throw err;
    }
    const retry = await connectBrowser(opts.cdpUrl, opts.ssrfPolicy, undefined, opts.engine);
    return await run(retry.browser);
  }
}

async function readPagesViaPlaywright(
  opts: {
    cdpUrl: string;
    engine?: BrowserEngineId;
    ssrfPolicy?: SsrFPolicy;
    requireCompleteTargetList?: boolean;
  },
  signal: AbortSignal,
): Promise<PlaywrightPageEnumeration> {
  return await withPlaywrightSafeReadReconnect(
    { cdpUrl: opts.cdpUrl, ssrfPolicy: opts.ssrfPolicy, signal, engine: opts.engine },
    async (browser) => {
      signal.throwIfAborted();
      const contexts = opts.requireCompleteTargetList ? browser.contexts() : [];
      let publication = createDeferred<void>();
      const wake = () => publication.resolve();
      const observedPages = new Set<Page>();
      let nativeTargetsChanged = false;
      const onPageClosed = () => {
        nativeTargetsChanged = true;
        wake();
      };
      const observePage = (page: Page) => {
        if (!observedPages.has(page)) {
          observedPages.add(page);
          page.on("close", onPageClosed);
        }
      };
      const onPage = (page: Page) => {
        observePage(page);
        wake();
      };
      let disconnected = false;
      const onDisconnected = () => {
        disconnected = true;
        wake();
      };
      // CDP discovery can finish before Playwright initializes and publishes each Page.
      // Subscribe before discovery so publication during either read cannot be lost.
      for (const context of contexts) {
        context.on("page", onPage);
        for (const page of context.pages()) {
          observePage(page);
        }
      }
      browser.on("disconnected", onDisconnected);
      signal.addEventListener("abort", wake, { once: true });
      try {
        const readNativeTargetIds = async () => {
          const session = browser.newBrowserCDPSession();
          let detaching: Promise<void> | undefined;
          const detach = () => {
            detaching ??= session.then((owned) => owned.detach()).catch(() => {});
          };
          const cancelled = createDeferred<never>();
          const onAbort = () => {
            cancelled.reject(signal.reason);
            detach();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
          try {
            const read = session.then((owned) => {
              signal.throwIfAborted();
              return owned.send("Target.getTargets");
            });
            const result = await Promise.race([read, cancelled.promise]);
            signal.throwIfAborted();
            if (!Array.isArray(result.targetInfos)) {
              throw new Error("Browser target enumeration was unavailable.");
            }
            return new Set(
              result.targetInfos
                .filter(
                  (info) => info.type === "page" && !isBlockedTarget(opts.cdpUrl, info.targetId),
                )
                .map((info) => info.targetId),
            );
          } finally {
            signal.removeEventListener("abort", onAbort);
            detach();
          }
        };
        let nativeTargetIds = opts.requireCompleteTargetList
          ? await readNativeTargetIds()
          : undefined;
        for (;;) {
          publication = createDeferred<void>();
          signal.throwIfAborted();
          if (disconnected) {
            throw new Error("Browser disconnected during page enumeration.");
          }
          const pages = await getAllPages(browser);
          const candidatePages = pages.filter((page) => !isBlockedPageRef(opts.cdpUrl, page));
          const pageResults = await Promise.all(
            candidatePages.map(async (page) => {
              let targetInfo: Awaited<ReturnType<typeof pageTargetInfo>>;
              try {
                targetInfo = await pageTargetInfo(page);
              } catch (err) {
                if (isRecoverablePlaywrightDisconnectError(err)) {
                  if (page.isClosed() && browser.isConnected()) {
                    return { status: "closed" as const };
                  }
                  throw err;
                }
                targetInfo = null;
              }
              if (!targetInfo) {
                return { status: "unresolved" as const };
              }
              if (isBlockedTarget(opts.cdpUrl, targetInfo.targetId)) {
                return { status: "blocked" as const };
              }
              let url = "";
              try {
                url = page.url();
              } catch (err) {
                if (isRecoverablePlaywrightDisconnectError(err)) {
                  throw err;
                }
              }
              return {
                status: "available" as const,
                page: {
                  targetId: targetInfo.targetId,
                  title: targetInfo.title,
                  url,
                  type: "page" as const,
                },
              };
            }),
          );
          signal.throwIfAborted();
          if (disconnected) {
            throw new Error("Browser disconnected during page enumeration.");
          }
          if (
            nativeTargetIds &&
            (nativeTargetsChanged || pageResults.some((result) => result.status === "closed"))
          ) {
            nativeTargetsChanged = false;
            nativeTargetIds = await readNativeTargetIds();
          }
          const remainingTargetIds = nativeTargetIds ? new Set(nativeTargetIds) : undefined;
          // Keep page order and native snapshot identities. A quarantined Page reference
          // cannot identify a missing native target without exposing its metadata.
          const resolvedPages = pageResults.flatMap((result) =>
            result.status === "available" &&
            (!remainingTargetIds || remainingTargetIds.delete(result.page.targetId))
              ? [result.page]
              : [],
          );
          if (
            (opts.requireCompleteTargetList || resolvedPages.length === 0) &&
            pageResults.some((result) => result.status === "unresolved")
          ) {
            return { status: "unavailable", reason: "target-identity-unresolved" };
          }
          if (!remainingTargetIds?.size) {
            return { status: "available", pages: resolvedPages };
          }
          await publication.promise;
        }
      } finally {
        for (const context of contexts) {
          context.off("page", onPage);
        }
        for (const page of observedPages) {
          page.off("close", onPageClosed);
        }
        browser.off("disconnected", onDisconnected);
        signal.removeEventListener("abort", wake);
      }
    },
  );
}

type PlaywrightPageEnumeration =
  | {
      status: "available";
      pages: Array<{ targetId: string; title: string; url: string; type: "page" }>;
    }
  | { status: "unavailable"; reason: "target-identity-unresolved" };

/** List pages through the persistent Playwright connection. */
export async function listPagesViaPlaywright(opts: {
  cdpUrl: string;
  engine?: BrowserEngineId;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  requireCompleteTargetList?: boolean;
  signal?: AbortSignal;
}) {
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : opts.requireCompleteTargetList
        ? DEFAULT_BROWSER_ACTION_TIMEOUT_MS
        : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const cancelled = createDeferred<never>();
  const onCancelled = () => cancelled.reject(controller.signal.reason);
  controller.signal.addEventListener("abort", onCancelled, { once: true });
  const onAbort = () =>
    controller.abort(
      opts.signal?.reason instanceof Error
        ? opts.signal.reason
        : new Error("Playwright page enumeration was aborted."),
    );
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) {
    onAbort();
  }
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Playwright page enumeration timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }
  try {
    const enumeration = await Promise.race([
      readPagesViaPlaywright(opts, controller.signal),
      cancelled.promise,
    ]);
    if (enumeration.status === "unavailable") {
      throw new Error("Playwright page target identities are temporarily unavailable.");
    }
    return enumeration.pages;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    opts.signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", onCancelled);
  }
}

/** Create a page and hand its exact cleanup operation to the adopting owner. */
export async function createPageViaPlaywright(
  opts: {
    cdpUrl: string;
    engine?: BrowserEngineId;
    url: string;
    cdpPolicy?: SsrFPolicy;
    signal?: AbortSignal;
    /** Caller authority is checked at each effect boundary, independently of cancellation. */
    assertCurrent?: () => void;
    /** Own an empty context; never reuse profile cookies for a session-scoped dashboard. */
    isolatedContext?: true;
  } & BrowserNavigationPolicyOptions,
): Promise<PlaywrightOwnedPage> {
  const assertCurrent = () => {
    opts.signal?.throwIfAborted();
    opts.assertCurrent?.();
  };
  assertCurrent();
  const targetUrl = opts.url.trim() || "about:blank";
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: opts.browserProxyMode,
  });
  await assertBrowserNavigationAllowed({
    url: targetUrl,
    ...navigationPolicy,
    signal: opts.signal,
  });
  assertCurrent();
  const { browser, engine } = await connectBrowser(
    opts.cdpUrl,
    opts.cdpPolicy ?? opts.ssrfPolicy,
    undefined,
    opts.engine,
  );
  assertCurrent();
  // Refusing a second connection-scoped page must not close the existing one.
  // Keep this check before allocation and outside the new-page cleanup owner.
  const adapter = resolveBrowserEngine(engine);
  if (
    adapter.maxPagesPerConnection !== undefined &&
    (await getAllPages(browser)).length >= adapter.maxPagesPerConnection
  ) {
    throw new Error(
      `${adapter.descriptor.label} supports ${adapter.maxPagesPerConnection} page per connection. Navigate the existing tab, or close it before opening another.`,
    );
  }
  assertCurrent();
  const context = opts.isolatedContext
    ? await browser.newContext({ acceptDownloads: false })
    : (browser.contexts()[0] ?? (await browser.newContext()));
  let page: Page | undefined;
  const close = async () => {
    if (opts.isolatedContext) {
      await context.close();
    } else if (adapter.descriptor.sessionScope === "connection") {
      await closeConnectionScopedPageBrowser(opts.cdpUrl, browser);
    } else {
      await page?.close();
    }
  };
  let navigationClosedBlockedTarget = false;
  try {
    assertCurrent();
    ensureContextState(context);
    page = await context.newPage();
    assertCurrent();
    ensurePageState(page);
    clearBlockedPageRef(opts.cdpUrl, page);
    const createdTargetId = (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
    assertCurrent();
    clearBlockedTarget(opts.cdpUrl, createdTargetId ?? undefined);

    if (targetUrl !== "about:blank") {
      let response: Response | null;
      try {
        response = await gotoPageWithNavigationGuard({
          cdpUrl: opts.cdpUrl,
          page,
          url: targetUrl,
          timeoutMs: 30_000,
          ...navigationPolicy,
          targetId: createdTargetId ?? undefined,
          assertPageCurrent: assertCurrent,
        });
      } catch (error) {
        // Guarded navigation already owns close/quarantine for a policy denial.
        navigationClosedBlockedTarget = isPolicyDenyNavigationError(error);
        throw error;
      }
      assertCurrent();
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response,
        ...navigationPolicy,
        targetId: createdTargetId ?? undefined,
      });
    }

    const tid = createdTargetId ?? (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
    assertCurrent();
    if (!tid) {
      throw new Error("Failed to get targetId for new page");
    }
    const title = await page.title().catch(() => "");
    assertCurrent();
    const retainedPage = page;
    return {
      targetId: tid,
      title,
      url: page.url(),
      type: "page",
      close,
      isCurrent: () =>
        browser.isConnected() && !retainedPage.isClosed() && context.pages().includes(retainedPage),
    };
  } catch (error) {
    if (opts.isolatedContext || !navigationClosedBlockedTarget) {
      await close().catch(() => {});
    }
    throw error;
  }
}

/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  await closeResolvedPageViaPlaywright(page, opts);
}

/** Close an already resolved page without bypassing dashboard or connection ownership. */
export async function closeResolvedPageViaPlaywright(
  page: Page,
  opts: {
    cdpUrl: string;
    signal?: AbortSignal;
    assertCurrent?: () => void | Promise<void>;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  if (readBrowserDashboardTabs().length > 0) {
    const targetId = (await pageTargetInfo(page))?.targetId;
    opts.signal?.throwIfAborted();
    if (!targetId) {
      throw new Error("Cannot verify that this page is not retained by a dashboard");
    }
    assertBrowserDashboardTabCanClose(targetId);
  }
  const assertion = opts.assertCurrent?.();
  if (assertion) {
    await assertion;
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

/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
  assertCurrent?: () => void | Promise<void>;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const assertion = opts.assertCurrent?.();
  if (assertion) {
    await assertion;
  }
  opts.signal?.throwIfAborted();
  await page.bringToFront();
}
