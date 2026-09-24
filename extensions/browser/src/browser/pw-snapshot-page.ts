import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Frame, Page } from "playwright-core";
import {
  getPageForTargetId,
  ensurePageState,
  assertPageNavigationCompletedSafely,
} from "./pw-session.js";
import type { SnapshotUrlEntry } from "./snapshot-urls.js";

export function resolveSnapshotTimeoutMs(timeoutMs: number | undefined): number {
  return Math.max(500, Math.min(60_000, Math.floor(parseFiniteNumber(timeoutMs) ?? 5_000)));
}

export async function collectSnapshotUrls(page: Page | Frame): Promise<SnapshotUrlEntry[]> {
  const urls = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const out: SnapshotUrlEntry[] = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = anchor instanceof HTMLAnchorElement ? anchor.href : "";
        if (!href || seen.has(href)) {
          continue;
        }
        const text =
          (anchor.textContent || anchor.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 121) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) {
          break;
        }
      }
      return out;
    })
    .catch(() => []);
  return Array.isArray(urls)
    ? urls.map((entry) => {
        entry.text = truncateUtf16Safe(entry.text, 120) || entry.url;
        return entry;
      })
    : [];
}

export async function prepareSnapshotPageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<Page> {
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
  return page;
}

export async function withSnapshotFrameGuard<T>(opts: {
  page: Page;
  /** Omit for page-wide AI snapshots, whose refs can include every frame. */
  frame?: Frame;
  signal?: AbortSignal;
  deadlineMs?: number;
  assertCurrent?: () => void;
  run: (assertCurrent: () => void) => Promise<T>;
}): Promise<T> {
  let frameCurrent = true;
  const onFrameChanged = (frame: Frame) => {
    if (!opts.frame || frame === opts.frame) {
      frameCurrent = false;
    }
  };
  opts.page.on("framenavigated", onFrameChanged);
  opts.page.on("framedetached", onFrameChanged);
  const assertCurrent = () => {
    opts.signal?.throwIfAborted();
    opts.assertCurrent?.();
    if (!frameCurrent) {
      throw new Error("Frame changed while its browser snapshot was being captured; retry.");
    }
    if (opts.deadlineMs !== undefined && performance.now() >= opts.deadlineMs) {
      throw new Error("Browser snapshot capture timed out.");
    }
  };
  try {
    assertCurrent();
    return await opts.run(assertCurrent);
  } finally {
    frameCurrent = false;
    opts.page.off("framenavigated", onFrameChanged);
    opts.page.off("framedetached", onFrameChanged);
  }
}
