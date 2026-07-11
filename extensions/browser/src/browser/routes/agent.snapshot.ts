/**
 * Browser snapshot, navigation, and screenshot routes.
 *
 * Handles profile-aware snapshot generation across Playwright and Chrome MCP,
 * navigation policy checks, media storage, and screenshot normalization.
 */
import path from "node:path";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { isPrivateNetworkAllowedByPolicy } from "../../infra/net/ssrf.js";
import { getImageMetadata } from "../../media/media-services.js";
import { ensureMediaDir, saveMediaBuffer } from "../../media/store.js";
import { captureScreenshot, snapshotAria, snapshotRoleViaCdp } from "../cdp.js";
import {
  evaluateChromeMcpScript,
  navigateChromeMcpPage,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "../chrome-mcp.js";
import {
  buildAiSnapshotFromChromeMcpSnapshot,
  flattenChromeMcpSnapshotToAriaNodes,
} from "../chrome-mcp.snapshot.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "../constants.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
} from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { AnnotationItem } from "../screenshot-annotate.js";
import { scaleAnnotations } from "../screenshot-annotate.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "../snapshot-urls.js";
import { normalizeBrowserTimerDelayMs } from "../timer-delay.js";
import { runExistingSessionActionWithNavigationGuard } from "./agent.act.existing-session-navigation-guard.js";
import {
  browserNavigationPolicyForProfile,
  getPwAiModule,
  handleRouteError,
  readBody,
  requirePwAi,
  resolveProfileContext,
  withPlaywrightRouteContext,
  withRouteTabContext,
} from "./agent.shared.js";
import { resolveTargetIdAfterNavigate } from "./agent.snapshot-target.js";
import {
  resolveSnapshotPlan,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot,
} from "./agent.snapshot.plan.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";
import { asyncBrowserRoute, jsonError, toBoolean, toStringOrEmpty } from "./utils.js";

const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";

type ChromeMcpSnapshotOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

function requiresBrowserNavigationEnforcement(
  opts: ReturnType<typeof browserNavigationPolicyForProfile>,
) {
  const hostnameRestricted = opts.ssrfPolicy?.hostnameAllowlist?.some(
    (hostname) => hostname.trim().length > 0,
  );
  return Boolean(
    opts.browserProxyMode === "explicit-browser-proxy" ||
    (opts.ssrfPolicy && (!isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) || hostnameRestricted)),
  );
}

async function collectChromeMcpSnapshotUrls(
  params: ChromeMcpSnapshotOperation,
): Promise<SnapshotUrlEntry[]> {
  const result = await evaluateChromeMcpScript({
    ...params,
    fn: `() => {
      const seen = new Set();
      const out = [];
      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        const href = anchor.href || "";
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 121) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) break;
      }
      return out;
    }`,
  }).catch(() => []);
  return Array.isArray(result)
    ? result
        .filter(
          (entry): entry is { text: string; url: string } =>
            entry &&
            typeof entry === "object" &&
            typeof (entry as { text?: unknown }).text === "string" &&
            typeof (entry as { url?: unknown }).url === "string",
        )
        .map((entry) => {
          entry.text = truncateUtf16Safe(entry.text, 120) || entry.url;
          return entry;
        })
    : [];
}

async function clearChromeMcpOverlay(params: ChromeMcpSnapshotOperation): Promise<void> {
  await evaluateChromeMcpScript({
    ...params,
    // Cleanup must outlive a route abort or injected labels remain in the user's tab.
    signal: undefined,
    fn: `() => {
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      return true;
    }`,
  }).catch(() => {});
}

async function renderChromeMcpLabels(
  params: ChromeMcpSnapshotOperation & {
    captureRef?: string;
    refs: string[];
  },
): Promise<{ labels: number; skipped: number }> {
  const refList = JSON.stringify(params.refs);
  const captureRef = JSON.stringify(params.captureRef ?? null);
  const result = await evaluateChromeMcpScript({
    ...params,
    args: params.refs,
    fn: `(...elements) => {
      const refs = ${refList};
      const captureRef = ${captureRef};
      document.querySelectorAll("[${CHROME_MCP_OVERLAY_ATTR}]").forEach((node) => node.remove());
      const root = document.createElement("div");
      root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "labels");
      root.style.position = "fixed";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "2147483647";
      let labels = 0;
      let skipped = 0;
      elements.forEach((el, index) => {
        const isCapturedElement = captureRef === refs[index];
        if (captureRef && !isCapturedElement) {
          return;
        }
        if (!(el instanceof Element)) {
          skipped += 1;
          return;
        }
        if (isCapturedElement) {
          el.scrollIntoView({ block: "center", inline: "center" });
        }
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) {
          skipped += 1;
          return;
        }
        labels += 1;
        const badge = document.createElement("div");
        badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
        badge.textContent = refs[index] || String(labels);
        badge.style.position = "fixed";
        badge.style.left = \`\${Math.max(0, rect.left + (isCapturedElement ? 2 : 0))}px\`;
        badge.style.top = \`\${Math.max(0, rect.top + (isCapturedElement ? 2 : 0))}px\`;
        badge.style.transform = isCapturedElement ? "none" : "translateY(-100%)";
        badge.style.padding = "2px 6px";
        badge.style.borderRadius = "999px";
        badge.style.background = "#FF4500";
        badge.style.color = "#fff";
        badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
        badge.style.whiteSpace = "nowrap";
        if (isCapturedElement) {
          badge.style.boxSizing = "border-box";
          badge.style.maxWidth = \`\${Math.max(1, rect.width - 4)}px\`;
          badge.style.maxHeight = \`\${Math.max(1, rect.height - 4)}px\`;
          badge.style.overflow = "hidden";
        }
        root.appendChild(badge);
      });
      document.documentElement.appendChild(root);
      return { labels, skipped };
    }`,
  });
  const labels =
    result &&
    typeof result === "object" &&
    typeof (result as { labels?: unknown }).labels === "number"
      ? (result as { labels: number }).labels
      : 0;
  const skipped =
    result &&
    typeof result === "object" &&
    typeof (result as { skipped?: unknown }).skipped === "number"
      ? (result as { skipped: number }).skipped
      : 0;
  return { labels, skipped };
}

async function saveNormalizedScreenshotResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  type: "png" | "jpeg";
  targetId: string;
  url: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
  annotations?: AnnotationItem[];
}) {
  // Measure original dimensions BEFORE normalization so we can rescale
  // annotation coordinates if the response pipeline shrinks the image
  // (longest-side or byte-budget cap). Annotation boxes are in the captured
  // image's pixel space, so they would otherwise drift from the saved media.
  const originalMeta = params.annotations?.length
    ? ((await getImageMetadata(params.buffer)) ?? undefined)
    : undefined;
  const normalized = await normalizeBrowserScreenshot(params.buffer, {
    maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  });
  const annotations = await rescaleAnnotationsForNormalization({
    annotations: params.annotations,
    originalMeta,
    normalizedBuffer: normalized.buffer,
  });
  await saveBrowserMediaResponse({
    res: params.res,
    buffer: normalized.buffer,
    contentType: normalized.contentType ?? `image/${params.type}`,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
    targetId: params.targetId,
    url: params.url,
    labels: params.labels,
    labelsCount: params.labelsCount,
    labelsSkipped: params.labelsSkipped,
    annotations,
  });
}

/**
 * Keep annotation coordinates aligned with the saved media after
 * normalizeBrowserScreenshot. Returns the original annotations unchanged
 * when normalization did not change the image dimensions, or when image
 * metadata is unavailable (best-effort: better to ship pre-resize coords
 * than to drop the field entirely).
 */
async function rescaleAnnotationsForNormalization(params: {
  annotations?: AnnotationItem[];
  originalMeta?: { width?: number; height?: number };
  normalizedBuffer: Buffer;
}): Promise<AnnotationItem[] | undefined> {
  if (!params.annotations || params.annotations.length === 0) {
    return params.annotations;
  }
  const orig = params.originalMeta;
  if (!orig?.width || !orig?.height) {
    return params.annotations;
  }
  const next = await getImageMetadata(params.normalizedBuffer);
  if (!next?.width || !next?.height) {
    return params.annotations;
  }
  if (next.width === orig.width && next.height === orig.height) {
    return params.annotations;
  }
  return scaleAnnotations(params.annotations, next.width / orig.width, next.height / orig.height);
}

async function saveBrowserMediaResponse(params: {
  res: BrowserResponse;
  buffer: Buffer;
  contentType: string;
  maxBytes: number;
  targetId: string;
  url: string;
  labels?: boolean;
  labelsCount?: number;
  labelsSkipped?: number;
  annotations?: AnnotationItem[];
}) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(
    params.buffer,
    params.contentType,
    "browser",
    params.maxBytes,
  );
  params.res.json({
    ok: true,
    path: path.resolve(saved.path),
    targetId: params.targetId,
    url: params.url,
    ...(params.labels ? { labels: true } : {}),
    ...(typeof params.labelsCount === "number" ? { labelsCount: params.labelsCount } : {}),
    ...(typeof params.labelsSkipped === "number" ? { labelsSkipped: params.labelsSkipped } : {}),
    ...(params.annotations && params.annotations.length > 0
      ? { annotations: params.annotations }
      : {}),
  });
}

function hasObservableBrowserState(state: unknown): boolean {
  if (!state || typeof state !== "object") {
    return false;
  }
  const dialogs = (state as { dialogs?: { pending?: unknown[]; recent?: unknown[] } }).dialogs;
  return Boolean(dialogs?.pending?.length || dialogs?.recent?.length);
}

function hasPendingDialogs(state: unknown): boolean {
  if (!state || typeof state !== "object") {
    return false;
  }
  const dialogs = (state as { dialogs?: { pending?: unknown[] } }).dialogs;
  return Boolean(dialogs?.pending?.length);
}

function browserStateResponseFields(state: unknown): { browserState?: unknown } {
  return hasObservableBrowserState(state) ? { browserState: state } : {};
}

/** Register snapshot, screenshot, and navigation endpoints. */
export function registerBrowserAgentSnapshotRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post(
    "/navigate",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const url = toStringOrEmpty(body.url);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      if (!url) {
        return jsonError(res, 400, "url is required");
      }
      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        run: async ({ profileCtx, tab, cdpUrl }) => {
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
            await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
            const result = await navigateChromeMcpPage({
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              url,
              signal: req.signal,
            });
            await assertBrowserNavigationResultAllowed({ url: result.url, ...ssrfPolicyOpts });
            return res.json({ ok: true, targetId: tab.targetId, ...result });
          }
          const pw = await requirePwAi(res, "navigate");
          if (!pw) {
            return;
          }
          const result = await pw.navigateViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            url,
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
          });
          const currentTargetId = await resolveTargetIdAfterNavigate({
            oldTargetId: tab.targetId,
            navigatedUrl: result.url,
            listTabs: () => profileCtx.listTabs(),
          });
          res.json({ ok: true, targetId: currentTargetId, ...result });
        },
      });
    }),
  );

  app.post(
    "/pdf",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
        return jsonError(res, 501, EXISTING_SESSION_LIMITS.snapshot.pdfUnsupported);
      }
      await withPlaywrightRouteContext({
        req,
        res,
        ctx,
        targetId,
        feature: "pdf",
        enforceCurrentUrlAllowed: true,
        run: async ({ cdpUrl, tab, pw }) => {
          const pdf = await pw.pdfViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
            signal: req.signal,
          });
          await saveBrowserMediaResponse({
            res,
            buffer: pdf.buffer,
            contentType: "application/pdf",
            maxBytes: pdf.buffer.byteLength,
            targetId: tab.targetId,
            url: tab.url,
          });
        },
      });
    }),
  );

  app.post(
    "/screenshot",
    asyncBrowserRoute(async (req, res) => {
      const body = readBody(req);
      const targetId = toStringOrEmpty(body.targetId) || undefined;
      const fullPage = toBoolean(body.fullPage) ?? false;
      const ref = toStringOrEmpty(body.ref) || undefined;
      const element = toStringOrEmpty(body.element) || undefined;
      const labels = toBoolean(body.labels) ?? false;
      const type = body.type === "jpeg" ? "jpeg" : "png";
      let timeoutMs: number;
      try {
        const timeoutMsRaw = readRoutePositiveInteger(body.timeoutMs, "timeoutMs");
        timeoutMs =
          timeoutMsRaw !== undefined
            ? normalizeBrowserTimerDelayMs(timeoutMsRaw)
            : DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS;
      } catch (err) {
        return jsonError(res, 400, String(err instanceof Error ? err.message : err));
      }

      if (fullPage && (ref || element)) {
        return jsonError(res, 400, "fullPage is not supported for element screenshots");
      }

      await withRouteTabContext({
        req,
        res,
        ctx,
        targetId,
        enforceCurrentUrlAllowed: true,
        run: async ({ profileCtx, tab, cdpUrl }) => {
          const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
          if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
            const operation: ChromeMcpSnapshotOperation = {
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              timeoutMs,
              signal: req.signal,
            };
            if (element) {
              return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.screenshotElement);
            }
            const existingSessionNavigationGuard = {
              ...operation,
              ...navigationPolicy,
              listTabs: () => profileCtx.listTabs({ timeoutMs, signal: req.signal }),
            };
            if (labels) {
              const labeled = await runExistingSessionActionWithNavigationGuard({
                execute: async () => {
                  // A fresh snapshot rotates Chrome MCP ref ids. For an element
                  // capture, preserve the caller's exact ref and label only that crop.
                  const refs = ref
                    ? [ref]
                    : Object.keys(
                        buildAiSnapshotFromChromeMcpSnapshot({
                          root: await takeChromeMcpSnapshot(operation),
                        }).refs,
                      );
                  const labelResult = await renderChromeMcpLabels({
                    ...operation,
                    captureRef: ref,
                    refs,
                  });
                  try {
                    return {
                      buffer: await takeChromeMcpScreenshot({
                        ...operation,
                        uid: ref,
                        fullPage,
                        format: type,
                      }),
                      labelResult,
                    };
                  } finally {
                    await clearChromeMcpOverlay(operation);
                  }
                },
                guard: existingSessionNavigationGuard,
              });
              await saveNormalizedScreenshotResponse({
                res,
                buffer: labeled.buffer,
                type,
                targetId: tab.targetId,
                url: tab.url,
                labels: true,
                labelsCount: labeled.labelResult.labels,
                labelsSkipped: labeled.labelResult.skipped,
              });
              return;
            }
            const capture = () =>
              takeChromeMcpScreenshot({
                ...operation,
                uid: ref,
                fullPage,
                format: type,
              });
            const buffer = await runExistingSessionActionWithNavigationGuard({
              execute: capture,
              guard: {
                ...existingSessionNavigationGuard,
                // A plain viewport capture is a pure read. Ref/full-page captures
                // can scroll or otherwise act on the document and keep post-checks.
                skipPostActionNavigationPollingForPureRead: !ref && !fullPage,
              },
            });
            await saveNormalizedScreenshotResponse({
              res,
              buffer,
              type,
              targetId: tab.targetId,
              url: tab.url,
            });
            return;
          }

          let buffer: Buffer;
          const shouldUsePlaywright =
            requiresBrowserNavigationEnforcement(navigationPolicy) ||
            labels ||
            shouldUsePlaywrightForScreenshot({
              profile: profileCtx.profile,
              wsUrl: tab.wsUrl,
              ref,
              element,
            });
          if (shouldUsePlaywright) {
            const pw = await requirePwAi(res, "screenshot");
            if (!pw) {
              return;
            }
            if (labels) {
              const labeled = await pw.snapshotRoleWithLabelsViaPlaywright({
                cdpUrl,
                targetId: tab.targetId,
                ...navigationPolicy,
                type,
                timeoutMs,
                fullPage,
                ref,
                element,
                signal: req.signal,
              });
              await saveNormalizedScreenshotResponse({
                res,
                buffer: labeled.buffer,
                type,
                targetId: tab.targetId,
                url: tab.url,
                labels: true,
                labelsCount: labeled.labels,
                labelsSkipped: labeled.skipped,
                annotations: labeled.annotations,
              });
              return;
            }
            const snap = await pw.takeScreenshotViaPlaywright({
              cdpUrl,
              targetId: tab.targetId,
              ...navigationPolicy,
              ref,
              element,
              fullPage,
              type,
              timeoutMs,
              signal: req.signal,
            });
            buffer = snap.buffer;
          } else {
            buffer = await captureScreenshot({
              wsUrl: tab.wsUrl ?? "",
              fullPage,
              format: type,
              quality: type === "jpeg" ? 85 : undefined,
              timeoutMs,
            });
          }

          await saveNormalizedScreenshotResponse({
            res,
            buffer,
            type,
            targetId: tab.targetId,
            url: tab.url,
          });
        },
      });
    }),
  );

  app.get(
    "/snapshot",
    asyncBrowserRoute(async (req, res) => {
      const profileCtx = resolveProfileContext(req, res, ctx);
      if (!profileCtx) {
        return;
      }
      const targetId = typeof req.query.targetId === "string" ? req.query.targetId.trim() : "";
      const pwModule = await getPwAiModule();
      const hasPlaywright = Boolean(pwModule);
      const plan = resolveSnapshotPlan({
        profile: profileCtx.profile,
        query: req.query,
        hasPlaywright,
      });

      try {
        const tab = await profileCtx.ensureTabAvailable(targetId || undefined, {
          allowPlaywrightFallback: hasPlaywright,
          signal: req.signal,
          timeoutMs: plan.timeoutMs,
        });
        const usesChromeMcp = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
        const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
        if ((plan.labels || plan.mode === "efficient") && plan.format === "aria") {
          return jsonError(res, 400, "labels/mode=efficient require format=ai");
        }
        if (usesChromeMcp && (plan.selectorValue || plan.frameSelectorValue)) {
          return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.snapshotSelector);
        }
        if (requiresBrowserNavigationEnforcement(ssrfPolicyOpts)) {
          await assertBrowserNavigationResultAllowed({
            url: tab.url,
            ...ssrfPolicyOpts,
          });
        }
        let observedBrowserState: unknown;
        if (!usesChromeMcp && pwModule) {
          observedBrowserState = await pwModule
            .getObservedBrowserStateViaPlaywright({
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              ...ssrfPolicyOpts,
            })
            .catch(() => undefined);
        }
        if (usesChromeMcp) {
          const operation: ChromeMcpSnapshotOperation = {
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs: plan.timeoutMs,
            signal: req.signal,
          };
          const snapshotRead = await runExistingSessionActionWithNavigationGuard({
            execute: async () => ({
              snapshot: await takeChromeMcpSnapshot(operation),
              urls:
                plan.format !== "aria" && plan.urls
                  ? await collectChromeMcpSnapshotUrls(operation)
                  : undefined,
            }),
            guard: {
              ...operation,
              ...ssrfPolicyOpts,
              listTabs: () =>
                profileCtx.listTabs({ timeoutMs: plan.timeoutMs, signal: req.signal }),
              skipPostActionNavigationPollingForPureRead: true,
            },
          });
          const snapshot = snapshotRead.snapshot;
          if (plan.format === "aria") {
            return res.json({
              ok: true,
              format: "aria",
              targetId: tab.targetId,
              url: tab.url,
              nodes: flattenChromeMcpSnapshotToAriaNodes(snapshot, plan.limit),
            });
          }
          const built = buildAiSnapshotFromChromeMcpSnapshot({
            root: snapshot,
            options: {
              interactive: plan.interactive ?? undefined,
              compact: plan.compact ?? undefined,
              maxDepth: plan.depth ?? undefined,
            },
            maxChars: plan.resolvedMaxChars,
          });
          const builtWithUrls = plan.urls
            ? {
                ...built,
                snapshot: appendSnapshotUrls(built.snapshot, snapshotRead.urls ?? []),
              }
            : built;
          if (plan.labels) {
            const refs = Object.keys(builtWithUrls.refs);
            const labeled = await runExistingSessionActionWithNavigationGuard({
              execute: async () => {
                const labelResult = await renderChromeMcpLabels({
                  ...operation,
                  refs,
                });
                try {
                  return {
                    buffer: await takeChromeMcpScreenshot({
                      ...operation,
                      format: "png",
                    }),
                    labelResult,
                  };
                } finally {
                  await clearChromeMcpOverlay(operation);
                }
              },
              guard: {
                ...operation,
                ...ssrfPolicyOpts,
                listTabs: () =>
                  profileCtx.listTabs({ timeoutMs: plan.timeoutMs, signal: req.signal }),
              },
            });
            const normalized = await normalizeBrowserScreenshot(labeled.buffer, {
              maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
              maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            });
            await ensureMediaDir();
            const saved = await saveMediaBuffer(
              normalized.buffer,
              normalized.contentType ?? "image/png",
              "browser",
              DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            );
            return res.json({
              ok: true,
              format: "ai",
              targetId: tab.targetId,
              url: tab.url,
              labels: true,
              labelsCount: labeled.labelResult.labels,
              labelsSkipped: labeled.labelResult.skipped,
              imagePath: path.resolve(saved.path),
              imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : "png",
              ...builtWithUrls,
            });
          }
          return res.json({
            ok: true,
            format: "ai",
            targetId: tab.targetId,
            url: tab.url,
            ...builtWithUrls,
          });
        }
        if (hasPendingDialogs(observedBrowserState)) {
          return res.json({
            ok: true,
            format: plan.format,
            targetId: tab.targetId,
            url: tab.url,
            blockedByDialog: true,
            ...browserStateResponseFields(observedBrowserState),
            ...(plan.format === "aria" ? { nodes: [] } : { snapshot: "", refs: {} }),
          });
        }
        if (plan.format === "ai") {
          const roleSnapshotArgs = {
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            selector: plan.selectorValue,
            frameSelector: plan.frameSelectorValue,
            refsMode: plan.refsMode,
            ...ssrfPolicyOpts,
            signal: req.signal,
            urls: plan.urls,
            timeoutMs: plan.timeoutMs,
            options: {
              interactive: plan.interactive ?? undefined,
              compact: plan.compact ?? undefined,
              maxDepth: plan.depth ?? undefined,
            },
          };

          const cdpRoleSnapshot = async () => {
            if (requiresBrowserNavigationEnforcement(ssrfPolicyOpts)) {
              return null;
            }
            if (!tab.wsUrl) {
              return null;
            }
            if (plan.selectorValue || plan.frameSelectorValue) {
              return null;
            }
            return await snapshotRoleViaCdp({
              wsUrl: tab.wsUrl,
              urls: plan.urls,
              timeoutMs: plan.timeoutMs,
              options: {
                interactive: plan.interactive ?? undefined,
                compact: plan.compact ?? undefined,
                maxDepth: plan.depth ?? undefined,
              },
            });
          };

          const pw = await getPwAiModule();
          const labeled = plan.labels
            ? pw
              ? await pw.snapshotRoleWithLabelsViaPlaywright({
                  ...roleSnapshotArgs,
                  type: "png",
                })
              : null
            : null;
          if (plan.labels && !labeled) {
            await requirePwAi(res, "snapshot labels");
            return;
          }
          const snap =
            labeled ??
            (plan.wantsRoleSnapshot
              ? pw
                ? await pw
                    .snapshotRoleViaPlaywright(roleSnapshotArgs)
                    .catch(async (err: unknown) => {
                      const fallback = await cdpRoleSnapshot();
                      if (fallback) {
                        return fallback;
                      }
                      throw err;
                    })
                : await cdpRoleSnapshot()
              : pw
                ? await pw.snapshotAiViaPlaywright({
                    cdpUrl: profileCtx.profile.cdpUrl,
                    targetId: tab.targetId,
                    ...ssrfPolicyOpts,
                    signal: req.signal,
                    urls: plan.urls,
                    timeoutMs: plan.timeoutMs,
                    ...(typeof plan.resolvedMaxChars === "number"
                      ? { maxChars: plan.resolvedMaxChars }
                      : {}),
                  })
                : await cdpRoleSnapshot());
          if (!snap) {
            await requirePwAi(res, "ai snapshot");
            return;
          }
          if (plan.labels) {
            if (!labeled) {
              throw new Error("Snapshot labels completed without a labeled result.");
            }
            const {
              buffer,
              labels: labelsCount,
              skipped: labelsSkipped,
              annotations,
              ...snapshotResult
            } = labeled;
            const originalMeta = annotations.length
              ? ((await getImageMetadata(buffer)) ?? undefined)
              : undefined;
            const normalized = await normalizeBrowserScreenshot(buffer, {
              maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
              maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            });
            const scaledAnnotations = await rescaleAnnotationsForNormalization({
              annotations,
              originalMeta,
              normalizedBuffer: normalized.buffer,
            });
            await ensureMediaDir();
            const saved = await saveMediaBuffer(
              normalized.buffer,
              normalized.contentType ?? "image/png",
              "browser",
              DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
            );
            const imageType = normalized.contentType?.includes("jpeg") ? "jpeg" : "png";
            return res.json({
              ok: true,
              format: plan.format,
              targetId: tab.targetId,
              url: tab.url,
              ...browserStateResponseFields(observedBrowserState),
              labels: true,
              labelsCount,
              labelsSkipped,
              ...(scaledAnnotations && scaledAnnotations.length > 0
                ? { annotations: scaledAnnotations }
                : {}),
              imagePath: path.resolve(saved.path),
              imageType,
              ...snapshotResult,
            });
          }

          return res.json({
            ok: true,
            format: plan.format,
            targetId: tab.targetId,
            url: tab.url,
            ...browserStateResponseFields(observedBrowserState),
            ...snap,
          });
        }

        const usePlaywrightAriaSnapshot =
          requiresBrowserNavigationEnforcement(ssrfPolicyOpts) ||
          shouldUsePlaywrightForAriaSnapshot({
            profile: profileCtx.profile,
            wsUrl: tab.wsUrl,
          });
        const snap = usePlaywrightAriaSnapshot
          ? (() => {
              // Extension relay doesn't expose per-page WS URLs; run AX snapshot via Playwright CDP session.
              // Also covers cases where wsUrl is missing/unusable.
              return requirePwAi(res, "aria snapshot").then(async (pw) => {
                if (!pw) {
                  return null;
                }
                return await pw.snapshotAriaViaPlaywright({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId: tab.targetId,
                  limit: plan.limit,
                  timeoutMs: plan.timeoutMs,
                  ...ssrfPolicyOpts,
                  signal: req.signal,
                });
              });
            })()
          : snapshotAria({ wsUrl: tab.wsUrl ?? "", limit: plan.limit, timeoutMs: plan.timeoutMs });

        const resolved = await Promise.resolve(snap);
        if (!resolved) {
          return;
        }
        if (!usePlaywrightAriaSnapshot) {
          await pwModule?.storeAriaSnapshotRefsViaPlaywright?.({
            cdpUrl: profileCtx.profile.cdpUrl,
            targetId: tab.targetId,
            nodes: resolved.nodes,
            signal: req.signal,
          });
        }
        return res.json({
          ok: true,
          format: plan.format,
          targetId: tab.targetId,
          url: tab.url,
          ...browserStateResponseFields(observedBrowserState),
          ...resolved,
        });
      } catch (err) {
        handleRouteError(ctx, res, err);
      }
    }),
  );
}
