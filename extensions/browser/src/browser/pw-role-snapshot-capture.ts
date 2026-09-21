import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { Frame, Page } from "playwright-core";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { snapshotRoleViaCdpSession } from "./cdp-role-snapshot.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  finalizeRoleSnapshot,
  type RoleSnapshotIdentityMode,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import { storeRoleRefsForTarget } from "./pw-session.js";
import {
  markBackendDomRefsOnPage,
  withPageScopedCdpClient,
  withCdpSnapshotRoot,
} from "./pw-session.page-cdp.js";
import {
  collectSnapshotUrls,
  prepareSnapshotPageViaPlaywright,
  resolveSnapshotTimeoutMs,
  withSnapshotFrameGuard,
} from "./pw-snapshot-page.js";
import { appendSnapshotUrls } from "./snapshot-urls.js";

async function finalizeRoleSnapshotViaPlaywright(params: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  frameSelector?: string;
  frame?: Frame;
  assertCurrent: () => void;
  mode: "aria" | "role";
  built: { snapshot: string; refs: RoleRefMap };
  urls?: boolean;
  maxChars?: number;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: RoleRefMap;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  newElements?: number;
}> {
  const snapshot = params.urls
    ? appendSnapshotUrls(
        params.built.snapshot,
        await collectSnapshotUrls(params.frame ?? params.page),
      )
    : params.built.snapshot;
  params.assertCurrent();
  const finalized = finalizeRoleSnapshot({
    snapshot,
    refs: params.built.refs,
    maxChars: params.maxChars,
    delta: params.delta,
  });
  storeRoleRefsForTarget({
    page: params.page,
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    refs: finalized.refs,
    ...(params.frameSelector ? { frameSelector: params.frameSelector } : {}),
    ...(params.frame ? { frame: params.frame } : {}),
    mode: params.mode,
  });
  return finalized;
}

/** Captures a role-ref snapshot used by model-facing browser interaction tools. */
export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
  urls?: boolean;
  maxChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
}): Promise<{
  snapshot: string;
  truncated?: boolean;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
  newElements?: number;
}> {
  const page = await prepareSnapshotPageViaPlaywright({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });

  const ariaSnapshotTimeout = resolveSnapshotTimeoutMs(opts.timeoutMs);
  const captureDeadline = performance.now() + ariaSnapshotTimeout;

  if (opts.refsMode === "aria") {
    if (normalizeOptionalString(opts.selector) || normalizeOptionalString(opts.frameSelector)) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    return await withSnapshotFrameGuard({
      page,
      signal: opts.signal,
      deadlineMs: captureDeadline,
      run: async (assertCurrent) => {
        const snapshot = await page.ariaSnapshot({
          mode: "ai",
          timeout: ariaSnapshotTimeout,
        });
        const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);
        if (opts.options === undefined) {
          built.snapshot = snapshot;
        }
        return await finalizeRoleSnapshotViaPlaywright({
          page,
          cdpUrl: opts.cdpUrl,
          targetId: opts.targetId,
          assertCurrent,
          built,
          mode: "aria",
          urls: opts.urls,
          maxChars: opts.maxChars,
          delta: opts.delta,
        });
      },
    });
  }

  const frameSelector = normalizeOptionalString(opts.frameSelector) ?? "";
  const selector = normalizeOptionalString(opts.selector) ?? "";
  const frameElement = frameSelector
    ? await page.locator(frameSelector).elementHandle({ timeout: ariaSnapshotTimeout })
    : undefined;
  let frame: Frame | undefined;
  if (frameElement) {
    try {
      frame = (await frameElement.contentFrame()) ?? undefined;
    } finally {
      await frameElement.dispose();
    }
  }
  if (frameSelector && !frame) {
    throw new Error("Frame was unavailable while its browser snapshot was being captured.");
  }
  return await withSnapshotFrameGuard({
    page,
    frame: frame ?? page.mainFrame(),
    signal: opts.signal,
    deadlineMs: captureDeadline,
    run: async (assertCurrent) => {
      const snapshotScope = frame ?? page;
      const locator = snapshotScope.locator(selector || ":root");
      // Count has no timeout; both capture stages share one budget before refs are published.
      const selectorMatched =
        !selector ||
        (await withTimeout(locator.count(), ariaSnapshotTimeout, "Role snapshot selector")) > 0;
      if (!selectorMatched) {
        return await finalizeRoleSnapshotViaPlaywright({
          ...opts,
          page,
          frameSelector: frameSelector || undefined,
          frame,
          assertCurrent,
          built: {
            snapshot: opts.options?.interactive ? "(no interactive elements)" : "(empty)",
            refs: {},
          },
          mode: "role",
          urls: false,
        });
      }
      const remaining = () => {
        assertCurrent();
        return Math.max(1, Math.ceil(captureDeadline - performance.now()));
      };
      const root = await locator.elementHandle({ timeout: remaining() });
      if (!root) {
        throw new Error("Snapshot root changed before native capture; retry.");
      }
      let result: Awaited<ReturnType<typeof snapshotRoleViaCdpSession>>;
      let captureOwnsRoot = false;
      try {
        result = await withPageScopedCdpClient({
          page,
          frame,
          timeoutMs: remaining(),
          fn: async (send) => {
            assertCurrent();
            captureOwnsRoot = true;
            try {
              return await withCdpSnapshotRoot({
                root,
                send,
                run: async (rootBackendNodeId) => {
                  const captured = await snapshotRoleViaCdpSession({
                    send,
                    rootBackendNodeId,
                    options: opts.options,
                    urlEntries: opts.urls ? await collectSnapshotUrls(snapshotScope) : undefined,
                    maxChars: opts.maxChars,
                    delta: opts.delta,
                    recurseIframes: false,
                  });
                  remaining();
                  const backendRefs = Object.entries(captured.refs).map(([ref, info]) => {
                    if (!info.backendDOMNodeId) {
                      throw new Error("Snapshot control has no DOM identity; retry.");
                    }
                    return { ref, backendDOMNodeId: info.backendDOMNodeId };
                  });
                  const marked = await markBackendDomRefsOnPage({
                    page,
                    frame,
                    send,
                    rootBackendNodeId,
                    refs: backendRefs,
                    assertCurrent,
                  });
                  if (marked.size !== backendRefs.length) {
                    throw new Error("Snapshot controls changed before refs were bound; retry.");
                  }
                  remaining();
                  const refs = Object.fromEntries(
                    Object.entries(captured.refs).map(([ref, info]) => {
                      const { backendDOMNodeId: _backend, ...metadata } = info;
                      return [ref, { ...metadata, domMarker: true }];
                    }),
                  );
                  return { ...captured, refs };
                },
              });
            } finally {
              // A timed-out session still owns marker cleanup until its work settles.
              void root.dispose().catch(() => {});
            }
          },
        });
      } finally {
        if (!captureOwnsRoot) {
          void root.dispose().catch(() => {});
        }
      }
      remaining();
      storeRoleRefsForTarget({
        page,
        frame,
        frameSelector: frameSelector || undefined,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: result.refs,
        mode: "role",
      });
      return result;
    },
  });
}
