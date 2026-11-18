import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core";
import { PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS } from "./cdp-timeouts.js";

type PageTargetInfo = { targetId: string; title: string };

// A Page owns one bounded target-info read at a time so concurrent enumerations share its
// temporary CDP session. Settled reads evict themselves so later calls observe fresh metadata.
const targetInfoReads = new WeakMap<Page, Promise<PageTargetInfo | null>>();
// The native target belongs to the Page, not its document. Navigations replace
// loaders, not targets; reconnects create new Pages and connection namespaces.
// Keep mutable metadata (title) and document identities out of this map.
const pageTargetIds = new WeakMap<Page, string>();

// Ephemeral engines reuse native target IDs after disconnect. Never let a ref
// from one connection select a replacement page on the next connection.
const connectionNamespaces = new WeakMap<BrowserContext, string>();
const connectionClosingContexts = new WeakSet<BrowserContext>();

export function markConnectionScopedBrowser(
  browser: Browser,
  closePageClosesConnection: boolean,
): void {
  const namespace = randomUUID();
  for (const context of browser.contexts()) {
    connectionNamespaces.set(context, namespace);
    if (closePageClosesConnection) {
      connectionClosingContexts.add(context);
    }
  }
}

export function isConnectionScopedPage(page: Page): boolean {
  return connectionNamespaces.has(page.context());
}

export function pageCloseClosesConnection(page: Page): boolean {
  return connectionClosingContexts.has(page.context());
}

export function isConnectionScopedTargetId(targetId: string | undefined): boolean {
  return targetId?.startsWith("connection:") === true;
}

async function readPageTargetInfo(page: Page): Promise<PageTargetInfo | null> {
  let session: CDPSession | undefined;
  let timedOut = false;
  let detachStarted = false;
  const detach = () => {
    if (!session || detachStarted) {
      return;
    }
    detachStarted = true;
    void session.detach().catch(() => {});
  };
  return await raceWithTimeout(
    async () => {
      session = await page.context().newCDPSession(page);
      if (timedOut) {
        detach();
        return null;
      }
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        const targetId = normalizeOptionalString(targetInfo.targetId) ?? "";
        if (!targetId) {
          return null;
        }
        const namespace = connectionNamespaces.get(page.context());
        const scopedTargetId = namespace ? `connection:${namespace}:${targetId}` : targetId;
        pageTargetIds.set(page, scopedTargetId);
        return { targetId: scopedTargetId, title: targetInfo.title };
      } finally {
        detach();
      }
    },
    PLAYWRIGHT_TARGET_INFO_TIMEOUT_MS,
    () => {
      timedOut = true;
      detach();
      return null;
    },
    { ref: false },
  );
}

export function pageTargetInfo(page: Page): Promise<PageTargetInfo | null> {
  const existing = targetInfoReads.get(page);
  if (existing) {
    return existing;
  }
  const pending = readPageTargetInfo(page);
  targetInfoReads.set(page, pending);
  const evict = () => {
    targetInfoReads.delete(page);
  };
  void pending.then(evict, evict);
  return pending;
}

/** Resolve only the immutable page identity, without refreshing tab metadata. */
export async function pageTargetId(page: Page): Promise<string | null> {
  return pageTargetIds.get(page) ?? (await pageTargetInfo(page))?.targetId ?? null;
}
