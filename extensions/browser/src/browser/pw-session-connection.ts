import { materializeErrorStack } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { withManagedProxyForCdpUrl, withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  assertCdpEndpointAllowed,
  getHeadersWithAuth,
  isLoopbackHost,
  isWebSocketUrl,
  redactCdpErrorText,
  stripCdpUrlCredentials,
  type CdpEndpointPin,
} from "./cdp.helpers.js";
import { getChromeWebSocketEndpoint } from "./chrome.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import type { BrowserEngineId } from "./engines/types.js";
import { BrowserActionError, BrowserTabNotFoundError } from "./errors.js";
import type { RelayOperationReference } from "./extension-relay/owner-client.js";
import {
  connectRelayBrowser,
  closeRelayOperationConnection,
  RELAY_PLAYWRIGHT_TIMEOUT_MS,
} from "./extension-relay/owner-playwright.js";
import { getRelayCdpAccess } from "./extension-relay/relay-access.js";
import {
  connectOverCdpTransport,
  reattachRelayPage,
  RelayPageRecoveryTimeoutError,
  UnresponsiveCdpTargetError,
} from "./pw-session-cdp-transport.js";
import {
  blockedPageRefsByCdpUrl,
  blockedTargetsByCdpUrl,
  cachedByCdpUrl,
  closeConnectionPromises,
  connectingByCdpUrl,
  contextStates,
  observedContexts,
  PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS,
  type ConnectedBrowser,
  type ContextState,
  type PlaywrightConnectionRetirement,
} from "./pw-session-contracts.js";
import { prepareMeetPlaybackObservation } from "./pw-session-meet-playback.js";
import {
  isConnectionScopedTargetId,
  markConnectionScopedBrowser,
  pageTargetInfo,
} from "./pw-session-page-target.js";
import {
  bindRoleRefsTarget,
  ensurePageState,
  normalizeCdpUrl,
  targetKey,
} from "./pw-session-state.js";
import {
  guardHeadlessContexts,
  isHeadlessChromium,
  refuseHeadlessPasskeyDialogs,
} from "./pw-session-webauthn.js";

export { pageTargetInfo } from "./pw-session-page-target.js";

export function hasCachedPlaywrightBrowserConnection(cdpUrl: string): boolean {
  return cachedByCdpUrl.has(normalizeCdpUrl(cdpUrl));
}

export function isRecoverablePlaywrightDisconnectError(err: unknown): boolean {
  const message = formatErrorMessage(err).toLowerCase();
  return (
    message.includes("target page, context or browser has been closed") ||
    message.includes("browser has been closed") ||
    message.includes("browser disconnected") ||
    message.includes("target closed") ||
    message.includes("connection closed") ||
    message.includes("websocket closed") ||
    message.includes("cdp socket closed")
  );
}

function isRecoverableStalePageSelectionError(err: unknown, reusedCachedBrowser: boolean): boolean {
  if (!reusedCachedBrowser) {
    return false;
  }
  if (
    err instanceof Error &&
    err.message.includes("No pages available in the connected browser.")
  ) {
    return true;
  }
  if (err instanceof BrowserTabNotFoundError) {
    return true;
  }
  const message = err instanceof Error ? err.message : formatErrorMessage(err);
  return message.toLowerCase().includes("tab not found");
}

export function isBlockedTarget(cdpUrl: string, targetId?: string): boolean {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return false;
  }
  return blockedTargetsByCdpUrl.has(targetKey(cdpUrl, normalizedTargetId));
}

export function markTargetBlocked(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.add(targetKey(cdpUrl, normalizedTargetId));
}

export function clearBlockedTarget(cdpUrl: string, targetId?: string): void {
  const normalizedTargetId = normalizeOptionalString(targetId) ?? "";
  if (!normalizedTargetId) {
    return;
  }
  blockedTargetsByCdpUrl.delete(targetKey(cdpUrl, normalizedTargetId));
}

export function clearBlockedTargetsForCdpUrl(cdpUrl?: string): void {
  if (!cdpUrl) {
    blockedTargetsByCdpUrl.clear();
    return;
  }
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) {
      blockedTargetsByCdpUrl.delete(key);
    }
  }
}

function blockedPageRefsForCdpUrl(cdpUrl: string): WeakSet<Page> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const existing = blockedPageRefsByCdpUrl.get(normalized);
  if (existing) {
    return existing;
  }
  const created = new WeakSet<Page>();
  blockedPageRefsByCdpUrl.set(normalized, created);
  return created;
}

export function isBlockedPageRef(cdpUrl: string, page: Page): boolean {
  return blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.has(page) ?? false;
}

export function markPageRefBlocked(cdpUrl: string, page: Page): void {
  blockedPageRefsForCdpUrl(cdpUrl).add(page);
}

export function clearBlockedPageRefsForCdpUrl(cdpUrl?: string): void {
  if (!cdpUrl) {
    blockedPageRefsByCdpUrl.clear();
    return;
  }
  blockedPageRefsByCdpUrl.delete(normalizeCdpUrl(cdpUrl));
}

export function clearBlockedPageRef(cdpUrl: string, page: Page): void {
  blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.delete(page);
}

function takeCachedPlaywrightBrowserConnection(cdpUrl: string): ConnectedBrowser | null {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  cachedByCdpUrl.delete(normalized);
  connectingByCdpUrl.delete(normalized);
  if (!cur) {
    return null;
  }
  if (cur.onDisconnected) {
    cur.browser.off("disconnected", cur.onDisconnected);
  }
  return cur;
}

/** Raised when a page target has been quarantined after policy denial. */
class BlockedBrowserTargetError extends Error {
  constructor() {
    super("Browser target is unavailable after SSRF policy blocked its navigation.");
    this.name = "BlockedBrowserTargetError";
  }
}

async function closeTrackedPlaywrightConnection(connection: ConnectedBrowser): Promise<void> {
  const existing = closeConnectionPromises.get(connection);
  if (existing) {
    return await existing;
  }
  const closing = connection.browser.close();
  closeConnectionPromises.set(connection, closing);
  try {
    return await closing;
  } catch (error) {
    materializeErrorStack(error);
    throw error;
  }
}

async function withPlaywrightCloseTimeout(task: Promise<void>): Promise<void> {
  await raceWithTimeout(
    task,
    PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS,
    () => {
      throw new Error("Playwright adapter disconnect timed out.");
    },
    { ref: false },
  );
}

/** Capture and retire only the adapter handles currently owned by one lifecycle transition. */
export function retirePlaywrightBrowserConnectionExact(opts: {
  cdpUrl: string;
}): PlaywrightConnectionRetirement {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  clearBlockedTargetsForCdpUrl(normalized);
  clearBlockedPageRefsForCdpUrl(normalized);
  const connections = new Map<ConnectedBrowser, Promise<void>>();
  const closing: Promise<void>[] = [];
  let retired = false;
  const captureConnection = (connection: ConnectedBrowser) => {
    let task = connections.get(connection);
    if (!task) {
      task = closeTrackedPlaywrightConnection(connection);
      connections.set(connection, task);
      closing.push(task);
      void task.catch(() => {});
    }
    return task;
  };
  const capture = () => {
    const pending = connectingByCdpUrl.get(normalized);
    const cached = takeCachedPlaywrightBrowserConnection(normalized);
    if (cached) {
      void captureConnection(cached);
    }
    if (pending) {
      const task = pending.then(captureConnection, () => {});
      closing.push(task);
      void task.catch(() => {});
    }
    const captured = Boolean(pending || cached);
    retired ||= captured;
    return captured;
  };
  capture();
  return {
    get retired() {
      return retired;
    },
    refresh: capture,
    close: async () => {
      // Failed disconnects are visible to the caller; a process restart is the recovery path.
      await withPlaywrightCloseTimeout(
        Promise.allSettled(closing).then((results) => {
          const failed = results.find((result) => result.status === "rejected");
          if (failed?.status === "rejected") {
            throw failed.reason;
          }
        }),
      );
    },
  };
}

export function evictStalePlaywrightBrowserConnection(
  cdpUrl: string,
  expectedBrowser?: Browser,
): void {
  const current = cachedByCdpUrl.get(normalizeCdpUrl(cdpUrl));
  if (expectedBrowser && current?.browser !== expectedBrowser) {
    return;
  }
  const cur = takeCachedPlaywrightBrowserConnection(cdpUrl);
  if (cur) {
    void closeTrackedPlaywrightConnection(cur).catch(() => {});
  }
}

/** Close a captured ephemeral browser without retiring a same-URL successor. */
export async function closeConnectionScopedPageBrowser(
  cdpUrl: string,
  browser: Browser,
): Promise<void> {
  const current = cachedByCdpUrl.get(normalizeCdpUrl(cdpUrl));
  if (current?.browser === browser) {
    clearBlockedTargetsForCdpUrl(cdpUrl);
    clearBlockedPageRefsForCdpUrl(cdpUrl);
    const owned = takeCachedPlaywrightBrowserConnection(cdpUrl);
    if (owned) {
      await withPlaywrightCloseTimeout(closeTrackedPlaywrightConnection(owned));
    }
    return;
  }
  // The obsolete handle is already disconnected or owned by its retirement.
  // Never look up and close the current adapter by endpoint alone here.
  if (browser.isConnected()) {
    await withPlaywrightCloseTimeout(browser.close());
  }
}

function hasBlockedTargetsForCdpUrl(cdpUrl: string): boolean {
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  for (const page of context.pages()) {
    ensurePageState(page);
  }
  context.on("page", (page) => ensurePageState(page));
}

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}

export async function connectBrowser(
  cdpUrl: string,
  ssrfPolicy?: SsrFPolicy,
  relayReference?: RelayOperationReference,
  engine?: BrowserEngineId,
): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const relayAccess = getRelayCdpAccess(normalized);
  const relay = relayAccess?.ownership === "borrowed" ? relayAccess : undefined;
  if (relayReference) {
    if (!relay) {
      throw new Error("Captured relay connection is unavailable");
    }
    const browser = await connectRelayBrowser(relay, normalized, relayReference);
    observeBrowser(browser);
    return { browser };
  }
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    if (engine && (cached.engine ?? "chromium") !== engine) {
      throw new Error("Browser engine changed; stop this profile before connecting again.");
    }
    return cached;
  }
  // Run SSRF policy check only on cache miss so transient DNS failures
  // do not break active sessions that already hold a live CDP connection.
  const configuredPin = await assertCdpEndpointAllowed(normalized, ssrfPolicy);
  const connectedDuringPolicyCheck = cachedByCdpUrl.get(normalized);
  if (connectedDuringPolicyCheck) {
    return connectedDuringPolicyCheck;
  }
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        let endpointDiscoveryError: unknown;
        const resolvedEndpoint = relay
          ? null
          : await getChromeWebSocketEndpoint(normalized, timeout, ssrfPolicy).catch(
              (err: unknown) => {
                endpointDiscoveryError = err;
                return null;
              },
            );
        const hasUrlCredentials = stripCdpUrlCredentials(normalized) !== normalized;
        const configuredIsWebSocket = isWebSocketUrl(normalized);
        if (!relay && !resolvedEndpoint && !configuredIsWebSocket) {
          if (hasUrlCredentials) {
            // Playwright preserves explicit headers across HTTP discovery redirects.
            // Keep credentialed discovery in OpenClaw's guarded fetch path instead.
            throw new Error(
              "Authenticated CDP HTTP endpoint did not expose a usable WebSocket URL.",
            );
          }
          const detail = endpointDiscoveryError
            ? ` Reason: ${redactCdpErrorText(formatErrorMessage(endpointDiscoveryError))}`
            : "";
          if (ssrfPolicy) {
            throw new Error(`Guarded CDP endpoint did not expose a usable WebSocket URL.${detail}`);
          }
        }
        const normalizedCdpHostname = new URL(normalized).hostname;
        const needsPinnedDependencyConnect =
          Boolean(configuredPin?.lookup) && !isLoopbackHost(normalizedCdpHostname);
        const endpointUrl = resolvedEndpoint?.url ?? normalized;
        const endpointLookup =
          resolvedEndpoint?.lookup ??
          (needsPinnedDependencyConnect ? configuredPin?.lookup : undefined);
        const connectEndpoint = async (target: string, lookup?: CdpEndpointPin["lookup"]) => {
          const headers = getHeadersWithAuth(target);
          const connectionUrl = stripCdpUrlCredentials(target);
          const resolveWebSocketUrl = isWebSocketUrl(connectionUrl)
            ? undefined
            : async () => (await getChromeWebSocketEndpoint(connectionUrl, timeout))?.url;
          // Keep both loopback bypasses active until the Playwright handshake settles.
          return await withManagedProxyForCdpUrl(connectionUrl, () =>
            withNoProxyForCdpUrl(connectionUrl, async () => {
              return await connectOverCdpTransport(connectionUrl, {
                timeout,
                headers,
                lookup,
                resolveWebSocketUrl,
                ...(engine ? { engine } : {}),
                deferInitialAutoAttach: Boolean(relayAccess),
                assertCurrent: relayAccess
                  ? () => {
                      if (getRelayCdpAccess(normalized) !== relayAccess) {
                        throw new Error("Relay connection was superseded");
                      }
                    }
                  : undefined,
              });
            }),
          );
        };
        let browser: Browser;
        try {
          browser = relay
            ? await connectRelayBrowser(relay, normalized)
            : await connectEndpoint(endpointUrl, endpointLookup);
          if (relayAccess && getRelayCdpAccess(normalized) !== relayAccess) {
            await browser.close();
            throw new Error("Relay connection was superseded");
          }
        } catch (err) {
          if (
            err instanceof UnresponsiveCdpTargetError ||
            !configuredIsWebSocket ||
            endpointUrl === normalized
          ) {
            throw err;
          }
          browser = await connectEndpoint(normalized, configuredPin?.lookup);
        }
        let disconnected = false;
        const onDisconnected = () => {
          disconnected = true;
          const current = cachedByCdpUrl.get(normalized);
          if (current?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
          }
        };
        // Listen before the awaited setup below, so a browser lost meanwhile is not cached.
        browser.on("disconnected", onDisconnected);
        const engineAdapter = resolveBrowserEngine(engine);
        if (engineAdapter.descriptor.sessionScope === "connection") {
          markConnectionScopedBrowser(browser);
        }
        // Relay connections drive the user's visible Chrome, which shows its own dialogs.
        const headless =
          !relayAccess && engineAdapter.descriptor.id === "chromium"
            ? await isHeadlessChromium(browser)
            : false;
        observeBrowser(browser);
        if (headless) {
          // Before any caller can load a document through this connection.
          await guardHeadlessContexts(browser.contexts());
        }
        if (disconnected) {
          browser.off("disconnected", onDisconnected);
          throw new Error("Browser disconnected while connecting.");
        }
        const connected: ConnectedBrowser = {
          browser,
          onDisconnected,
          engine,
          headless,
        };
        if (connectingByCdpUrl.get(normalized) === pending) {
          cachedByCdpUrl.set(normalized, connected);
        }
        return connected;
      } catch (err) {
        lastErr = err;
        if (relayAccess) {
          break;
        }
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = formatErrorMessage(err);
        if (err instanceof UnresponsiveCdpTargetError || errMsg.includes("rate limit")) {
          break;
        }
        await sleepWithAbort(250 + attempt * 250);
      }
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    // Never retain the raw dependency error as a cause: Playwright includes
    // connection URLs in some HTTP and WebSocket failures.
    throw new Error(redactCdpErrorText(message));
  };

  const pending = connectWithRetry().finally(() => {
    if (connectingByCdpUrl.get(normalized) === pending) {
      connectingByCdpUrl.delete(normalized);
    }
  });
  connectingByCdpUrl.set(normalized, pending);

  return await pending;
}

export async function getAllPages(browser: Browser): Promise<Page[]> {
  return browser.contexts().flatMap((context) => context.pages());
}

async function getAccessiblePages(opts: {
  cdpUrl: string;
  pages: Page[];
}): Promise<Array<{ page: Page; targetId: string | null }>> {
  const accessible: Array<{ page: Page; targetId: string | null }> = [];
  const candidates = await Promise.all(
    opts.pages.map(async (page) => {
      if (isBlockedPageRef(opts.cdpUrl, page)) {
        return { page, targetId: null };
      }
      ensurePageState(page);
      const targetId = (await pageTargetInfo(page).catch(() => null))?.targetId ?? null;
      return { page, targetId };
    }),
  );
  for (const { page, targetId } of candidates) {
    // Fail closed when we cannot resolve a target id while this session has
    // quarantined targets; otherwise a blocked tab can become selectable.
    if (
      isBlockedPageRef(opts.cdpUrl, page) ||
      (targetId ? isBlockedTarget(opts.cdpUrl, targetId) : hasBlockedTargetsForCdpUrl(opts.cdpUrl))
    ) {
      continue;
    }
    bindRoleRefsTarget(page, opts.cdpUrl, targetId);
    accessible.push({ page, targetId });
  }
  return accessible;
}

async function waitForRelayPages(browser: Browser, cdpUrl: string, targetId?: string) {
  const contexts = browser.contexts();
  let publication = createDeferred<void>();
  let disconnected = false;
  let finished = false;
  let recoveryAttempted = false;
  const deadline = Date.now() + RELAY_PLAYWRIGHT_TIMEOUT_MS;
  const wake = () => publication.resolve();
  const onDisconnected = () => {
    disconnected = true;
    wake();
  };
  for (const context of contexts) {
    context.on("page", wake);
  }
  browser.on("disconnected", onDisconnected);
  try {
    return await raceWithTimeout(
      (async () => {
        for (;;) {
          if (finished) {
            throw new Error("Page initialization wait ended.");
          }
          const changed = publication;
          if (disconnected || !browser.isConnected()) {
            throw new Error("Browser disconnected while waiting for page initialization.");
          }
          const accessible = await getAccessiblePages({
            cdpUrl,
            pages: await getAllPages(browser),
          });
          // Playwright also publishes initialization failures, using a dummy main
          // frame whose URL is empty. Such a Page is not ready for URL guards or
          // actions; recreate only its logical session, keeping healthy peers.
          const ready = accessible.filter(({ page }) => Boolean(page.url()));
          if (ready.some((entry) => !targetId || entry.targetId === targetId)) {
            return ready;
          }
          const failed = targetId && accessible.find((entry) => entry.targetId === targetId);
          if (targetId && !recoveryAttempted) {
            try {
              if (
                await reattachRelayPage(
                  browser,
                  targetId,
                  Math.max(1, deadline - Date.now()),
                  !failed,
                )
              ) {
                recoveryAttempted = true;
                continue;
              }
              recoveryAttempted = Boolean(failed);
            } catch (error) {
              if (!(error instanceof RelayPageRecoveryTimeoutError)) {
                throw error;
              }
              throw new BrowserActionError(
                `Browser tab ${JSON.stringify(targetId)} did not become ready. Retry this tab after it responds.`,
                409,
              );
            }
          }
          await changed.promise;
          if (publication === changed) {
            publication = createDeferred<void>();
          }
        }
      })(),
      RELAY_PLAYWRIGHT_TIMEOUT_MS,
      () => {
        throw new BrowserActionError(
          `Browser tab ${JSON.stringify(targetId ?? "requested")} did not become ready. Retry this tab after it responds.`,
          409,
        );
      },
    );
  } finally {
    finished = true;
    wake();
    for (const context of contexts) {
      context.off("page", wake);
    }
    browser.off("disconnected", onDisconnected);
  }
}

async function getPageForTargetIdOnce(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  relayReference?: RelayOperationReference;
}): Promise<Page> {
  if (opts.targetId && isBlockedTarget(opts.cdpUrl, opts.targetId)) {
    throw new BlockedBrowserTargetError();
  }
  const { browser, headless, engine } = await connectBrowser(
    opts.cdpUrl,
    opts.ssrfPolicy,
    opts.relayReference,
  );
  const pages = await getAllPages(browser);
  const relay = getRelayCdpAccess(normalizeCdpUrl(opts.cdpUrl));
  if (!pages.length && !relay) {
    throw new Error("No pages available in the connected browser.");
  }

  const accessible = relay
    ? await waitForRelayPages(browser, opts.cdpUrl, opts.targetId)
    : await getAccessiblePages({ cdpUrl: opts.cdpUrl, pages });
  if (!accessible.length) {
    throw new BlockedBrowserTargetError();
  }
  const found = opts.targetId
    ? accessible.find((entry) => entry.targetId === opts.targetId)
    : accessible[0];
  if (found) {
    bindRoleRefsTarget(found.page, opts.cdpUrl, found.targetId);
    if (!engine || engine === "chromium") {
      await prepareMeetPlaybackObservation(found.page);
    }
    if (headless) {
      // Settled guards are cached; this only re-registers one that failed.
      void refuseHeadlessPasskeyDialogs(found.page.context());
    }
    return found.page;
  }
  throw new BrowserTabNotFoundError();
}

/** Resolve a Playwright page by target id, reconnecting once on stale state. */
export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
  relayReference?: RelayOperationReference;
}): Promise<Page> {
  const cachedBrowser = cachedByCdpUrl.get(normalizeCdpUrl(opts.cdpUrl))?.browser;
  if (isConnectionScopedTargetId(opts.targetId) && !cachedBrowser) {
    throw new Error(
      "Browser session was lost. Open a new page and take a new snapshot; previous targets and refs are invalid.",
    );
  }
  try {
    return await getPageForTargetIdOnce(opts);
  } catch (err) {
    if (
      isConnectionScopedTargetId(opts.targetId) ||
      !isRecoverableStalePageSelectionError(err, Boolean(cachedBrowser))
    ) {
      throw err;
    }
    if (opts.relayReference) {
      await closeRelayOperationConnection(opts.relayReference);
    } else {
      evictStalePlaywrightBrowserConnection(opts.cdpUrl, cachedBrowser);
    }
    return await getPageForTargetIdOnce(opts);
  }
}
