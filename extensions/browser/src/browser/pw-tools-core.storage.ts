import type { BrowserContext } from "playwright-core";
import { getPageForTargetId } from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";
import {
  assertInteractionCurrent,
  type InteractionTargetOptions,
} from "./pw-tools-core.interactions.navigation.js";

type PlaywrightCookieInput = Parameters<BrowserContext["addCookies"]>[0][number];

export async function cookiesGetViaPlaywright(
  opts: InteractionTargetOptions & {
    partition?: "unpartitioned";
    signal?: AbortSignal;
  },
): Promise<{ cookies: unknown[]; cookiePartition?: "unpartitioned" }> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  if (opts.partition === "unpartitioned") {
    return await withPageScopedCdpClient({
      page,
      fn: async (send) => {
        await assertInteractionCurrent(opts);
        opts.signal?.throwIfAborted();
        // Page-scoped Network binds the selected storage partition. Storage.getCookies
        // without a browser-context id instead reads the default browser context.
        const result = await send("Network.getAllCookies");
        await assertInteractionCurrent(opts);
        opts.signal?.throwIfAborted();
        if (
          !result ||
          !Array.isArray(result.cookies) ||
          result.cookies.some(
            (cookie) => !cookie || typeof cookie !== "object" || Array.isArray(cookie),
          )
        ) {
          throw new Error("Invalid browser cookie response");
        }
        // Filter before Playwright drops opaque/nonce markers. Presence, even false
        // or malformed metadata, never certifies an ordinary cookie. Keep selected
        // rows intact rather than joining them to a second, lossy cookie snapshot.
        const cookies = result.cookies.filter(
          (cookie) => !("partitionKey" in cookie) && !("partitionKeyOpaque" in cookie),
        );
        return { cookies, cookiePartition: "unpartitioned" };
      },
    });
  }
  const cookies = await page.context().cookies();
  return { cookies };
}

export async function cookiesSetViaPlaywright(
  opts: InteractionTargetOptions & {
    cookie: PlaywrightCookieInput;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  const cookie = opts.cookie;
  if (!cookie.name) {
    throw new Error("cookie name and value are required");
  }
  const hasUrl = cookie.url?.trim();
  const hasDomainPath = cookie.domain?.trim() && cookie.path?.trim();
  if (!hasUrl && !hasDomainPath) {
    throw new Error("cookie requires url, or domain+path");
  }
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.context().addCookies([cookie]);
}

/**
 * Add cookies in bounded batches on one browser context. On a batch error, retry
 * that batch cookie-by-cookie so one cookie Playwright rejects neither drops the
 * whole batch nor aborts the import. Returns the count actually added so callers
 * can report rejects instead of leaving an ambiguous partial write.
 */
export async function cookiesSetManyViaPlaywright(
  opts: InteractionTargetOptions & {
    cookies: PlaywrightCookieInput[];
    signal?: AbortSignal;
  },
): Promise<{ added: number }> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  const context = page.context();
  let added = 0;
  for (let index = 0; index < opts.cookies.length; index += 500) {
    opts.signal?.throwIfAborted();
    const batch = opts.cookies.slice(index, index + 500);
    if (opts.assertCurrent) {
      await assertInteractionCurrent(opts);
      opts.signal?.throwIfAborted();
    }
    try {
      await context.addCookies(batch);
      added += batch.length;
    } catch {
      for (const cookie of batch) {
        opts.signal?.throwIfAborted();
        if (opts.assertCurrent) {
          await assertInteractionCurrent(opts);
          opts.signal?.throwIfAborted();
        }
        try {
          await context.addCookies([cookie]);
          added += 1;
        } catch {
          // Individual cookie rejected by Playwright/Chrome; counted as not added.
        }
      }
    }
  }
  opts.signal?.throwIfAborted();
  return { added };
}

export async function cookiesClearViaPlaywright(opts: InteractionTargetOptions): Promise<void> {
  const page = await getPageForTargetId(opts);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.context().clearCookies();
}

type StorageKind = "local" | "session";

export async function storageGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key?: string;
}): Promise<{ values: Record<string, string> }> {
  const page = await getPageForTargetId(opts);
  const kind = opts.kind;
  const key = opts.key;
  // Entry pairs preserve keys that Playwright omits when deserializing objects.
  const entries = await page.evaluate(
    ({ kind: kind2, key: key2 }): Array<[string, string]> => {
      const store = kind2 === "session" ? window.sessionStorage : window.localStorage;
      if (key2) {
        const value = store.getItem(key2);
        return value === null ? [] : [[key2, value]];
      }
      const out: Array<[string, string]> = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k === null) {
          continue;
        }
        const v = store.getItem(k);
        if (v !== null) {
          out.push([k, v]);
        }
      }
      return out;
    },
    { kind, key },
  );
  return { values: Object.fromEntries(entries) };
}

export async function storageSetViaPlaywright(
  opts: InteractionTargetOptions & {
    kind: StorageKind;
    key: string;
    value: string;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.evaluate(
    ({ kind, key: k, value }) => {
      const store = kind === "session" ? window.sessionStorage : window.localStorage;
      store.setItem(k, value);
    },
    { kind: opts.kind, key: opts.key, value: opts.value },
  );
}

export async function storageClearViaPlaywright(
  opts: InteractionTargetOptions & {
    kind: StorageKind;
  },
): Promise<void> {
  const page = await getPageForTargetId(opts);
  if (opts.assertCurrent) {
    await assertInteractionCurrent(opts);
  }
  await page.evaluate(
    ({ kind }) => {
      const store = kind === "session" ? window.sessionStorage : window.localStorage;
      store.clear();
    },
    { kind: opts.kind },
  );
}
