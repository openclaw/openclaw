/** Page-bound snapshot primitives. Callers own navigation-policy guarding. */
import { parseFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Page } from "playwright-core";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import { storeRoleRefsForTarget } from "./pw-session.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "./snapshot-urls.js";

export type RoleSnapshotResult = {
  snapshot: string;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
};

export type RoleSnapshotOnPageOptions = {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  urls?: boolean;
  timeoutMs?: number;
};

export function resolveSnapshotTimeoutMs(timeoutMs: number | undefined): number {
  const parsed = parseFiniteNumber(timeoutMs);
  return Math.max(500, Math.min(60_000, Math.floor(parsed ?? 5_000)));
}

export async function collectSnapshotUrlsOnPage(page: Page): Promise<SnapshotUrlEntry[]> {
  const urls = await page
    .evaluate(() => {
      const seen = new Set<string>();
      const out: SnapshotUrlEntry[] = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
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

async function finalizeRoleSnapshotOnPage(params: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  frameSelector?: string;
  mode: "aria" | "role";
  built: { snapshot: string; refs: RoleRefMap };
  urls?: boolean;
}): Promise<RoleSnapshotResult> {
  const snapshot = params.urls
    ? appendSnapshotUrls(params.built.snapshot, await collectSnapshotUrlsOnPage(params.page))
    : params.built.snapshot;
  storeRoleRefsForTarget({
    page: params.page,
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    refs: params.built.refs,
    ...(params.frameSelector ? { frameSelector: params.frameSelector } : {}),
    mode: params.mode,
  });
  return {
    snapshot,
    refs: params.built.refs,
    stats: getRoleSnapshotStats(snapshot, params.built.refs),
  };
}

/** Capture and store a role snapshot on an already-resolved, already-guarded page. */
export async function snapshotRoleOnPageViaPlaywright(
  opts: RoleSnapshotOnPageOptions,
): Promise<RoleSnapshotResult> {
  const timeout = resolveSnapshotTimeoutMs(opts.timeoutMs);
  if (opts.refsMode === "aria") {
    if (normalizeOptionalString(opts.selector) || normalizeOptionalString(opts.frameSelector)) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    const snapshot = await opts.page.ariaSnapshot({
      mode: "ai",
      timeout,
    });
    return await finalizeRoleSnapshotOnPage({
      page: opts.page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      built: buildRoleSnapshotFromAiSnapshot(snapshot, opts.options),
      mode: "aria",
      urls: opts.urls,
    });
  }

  const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
  const selector = normalizeOptionalString(opts.selector) ?? "";
  const locator = frameSelector
    ? selector
      ? opts.page.frameLocator(frameSelector).locator(selector)
      : opts.page.frameLocator(frameSelector).locator(":root")
    : selector
      ? opts.page.locator(selector)
      : opts.page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot({ timeout });
  return await finalizeRoleSnapshotOnPage({
    page: opts.page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    frameSelector: frameSelector || undefined,
    built: buildRoleSnapshotFromAriaSnapshot(ariaSnapshot ?? "", opts.options),
    mode: "role",
    urls: opts.urls,
  });
}
