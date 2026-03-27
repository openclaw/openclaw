import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type AriaSnapshotNode, formatAriaSnapshot, type RawAXNode } from "./cdp.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import {
  assertPageNavigationCompletedSafely,
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  storeRoleRefsForTarget,
  type WithSnapshotForAI,
} from "./pw-session.js";
import { withPageScopedCdpClient } from "./pw-session.page-cdp.js";

type SnapshotTargetOpts = {
  cdpUrl: string;
  targetId?: string;
  signal?: AbortSignal;
  disconnectReason?: string;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
}

async function runAbortableSnapshotWork<T>(
  opts: SnapshotTargetOpts,
  work: () => Promise<T>,
): Promise<T> {
  const signal = opts.signal;
  if (!signal) {
    return await work();
  }

  const abortReason = () => signal.reason ?? new Error("aborted");
  const disconnect = () => {
    void forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: opts.disconnectReason ?? "abort browser snapshot",
    }).catch(() => {});
  };

  if (signal.aborted) {
    disconnect();
    throw abortReason();
  }

  let completed = false;
  let abortTriggered = false;
  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = new Promise((_, reject) => {
    abortListener = () => {
      if (completed || abortTriggered) {
        return;
      }
      abortTriggered = true;
      disconnect();
      reject(abortReason());
    };
    signal.addEventListener("abort", abortListener, { once: true });
  });

  if (signal.aborted) {
    abortListener?.();
  }
  if (abortTriggered) {
    return await abortPromise;
  }

  const workPromise = work().finally(() => {
    completed = true;
  });

  try {
    return await Promise.race([workPromise, abortPromise]);
  } catch (err) {
    void workPromise.catch(() => {});
    throw err;
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  return await runAbortableSnapshotWork(opts, async () => {
    const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
    const page = await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    });
    ensurePageState(page);
    if (opts.ssrfPolicy) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: null,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }
    const res = (await withPageScopedCdpClient({
      cdpUrl: opts.cdpUrl,
      page,
      targetId: opts.targetId,
      fn: async (send) => {
        await send("Accessibility.enable").catch(() => {});
        return (await send("Accessibility.getFullAXTree")) as {
          nodes?: RawAXNode[];
        };
      },
    })) as {
      nodes?: RawAXNode[];
    };
    const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
    return { nodes: formatAriaSnapshot(nodes, limit) };
  });
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  return await runAbortableSnapshotWork(opts, async () => {
    const page = await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    });
    ensurePageState(page);
    if (opts.ssrfPolicy) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: null,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }

    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
      throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
    }

    const result = await maybe._snapshotForAI({
      timeout: Math.max(500, Math.min(60_000, Math.floor(opts.timeoutMs ?? 5000))),
      track: "response",
    });
    let snapshot = result?.full ?? "";
    const maxChars = opts.maxChars;
    const limit =
      typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
        ? Math.floor(maxChars)
        : undefined;
    let truncated = false;
    if (limit && snapshot.length > limit) {
      snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
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
  });
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  return await runAbortableSnapshotWork(opts, async () => {
    const page = await getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
    });
    ensurePageState(page);
    if (opts.ssrfPolicy) {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: null,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }

    if (opts.refsMode === "aria") {
      if (normalizeOptionalString(opts.selector) || normalizeOptionalString(opts.frameSelector)) {
        throw new Error("refs=aria does not support selector/frame snapshots yet.");
      }
      const maybe = page as unknown as WithSnapshotForAI;
      if (!maybe._snapshotForAI) {
        throw new Error("refs=aria requires Playwright _snapshotForAI support.");
      }
      const result = await maybe._snapshotForAI({
        timeout: 5000,
        track: "response",
      });
      const built = buildRoleSnapshotFromAiSnapshot(result?.full ?? "", opts.options);
      storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: built.refs,
        mode: "aria",
      });
      return {
        snapshot: built.snapshot,
        refs: built.refs,
        stats: getRoleSnapshotStats(built.snapshot, built.refs),
      };
    }

    const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
    const selector = normalizeOptionalString(opts.selector) ?? "";
    const locator = frameSelector
      ? selector
        ? page.frameLocator(frameSelector).locator(selector)
        : page.frameLocator(frameSelector).locator(":root")
      : selector
        ? page.locator(selector)
        : page.locator(":root");

    const ariaSnapshot = await locator.ariaSnapshot();
    const built = buildRoleSnapshotFromAriaSnapshot(ariaSnapshot ?? "", opts.options);
    storeRoleRefsForTarget({
      page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      refs: built.refs,
      frameSelector: frameSelector || undefined,
      mode: "role",
    });
    return {
      snapshot: built.snapshot,
      refs: built.refs,
      stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
  });
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  return await runAbortableSnapshotWork(
    {
      ...opts,
      disconnectReason: "abort browser navigate",
    },
    async () => {
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
      await assertBrowserNavigationAllowed({
        url,
        ...withBrowserNavigationPolicy(opts.ssrfPolicy),
      });
      const timeout = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000));
      let page = await getPageForTargetId(opts);
      ensurePageState(page);
      throwIfAborted(opts.signal);
      const navigate = async () =>
        await gotoPageWithNavigationGuard({
          cdpUrl: opts.cdpUrl,
          page,
          url,
          timeoutMs: timeout,
          ssrfPolicy: opts.ssrfPolicy,
          targetId: opts.targetId,
        });
      let response;
      try {
        response = await navigate();
      } catch (err) {
        if (opts.signal?.aborted) {
          throw opts.signal.reason ?? new Error("aborted");
        }
        if (!isRetryableNavigateError(err)) {
          throw err;
        }
        // Extension relays can briefly drop CDP during renderer swaps/navigation.
        // Force a clean reconnect, then retry once on the refreshed page handle.
        await forceDisconnectPlaywrightForTarget({
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          reason: "retry navigate after detached frame",
        }).catch(() => {});
        page = await getPageForTargetId(opts);
        ensurePageState(page);
        throwIfAborted(opts.signal);
        response = await navigate();
      }
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
      const finalUrl = page.url();
      return { url: finalUrl };
    },
  );
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<void> {
  await runAbortableSnapshotWork(
    {
      ...opts,
      disconnectReason: "abort browser resize",
    },
    async () => {
      const page = await getPageForTargetId(opts);
      ensurePageState(page);
      await page.setViewportSize({
        width: Math.max(1, Math.floor(opts.width)),
        height: Math.max(1, Math.floor(opts.height)),
      });
    },
  );
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  await runAbortableSnapshotWork(
    {
      ...opts,
      disconnectReason: "abort browser close",
    },
    async () => {
      const page = await getPageForTargetId(opts);
      ensurePageState(page);
      await page.close();
    },
  );
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  signal?: AbortSignal;
}): Promise<{ buffer: Buffer }> {
  return await runAbortableSnapshotWork(
    {
      ...opts,
      disconnectReason: "abort browser pdf",
    },
    async () => {
      const page = await getPageForTargetId(opts);
      ensurePageState(page);
      const buffer = await page.pdf({ printBackground: true });
      return { buffer };
    },
  );
}
