// Browser snapshot, navigation, and screenshot routes.
import path from "node:path";
import {
  ensureMediaDir,
  getImageMetadata,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import { resolveBrowserNavigationTimeoutMs } from "../act-policy.js";
import type { CdpDocumentIdentities } from "../cdp-page-session.js";
import {
  captureScreenshot,
  getDocumentIdentitiesViaCdp,
  snapshotAria,
  snapshotRoleViaCdp,
} from "../cdp.js";
import {
  navigateChromeMcpPage,
  takeChromeMcpScreenshot,
  takeChromeMcpSnapshot,
} from "../chrome-mcp.js";
import {
  collectChromeMcpSnapshotUrls,
  withChromeMcpLabels,
  type ChromeMcpSnapshotOperation,
} from "../chrome-mcp.snapshot-page.js";
import {
  buildChromeMcpRouteSnapshot,
  flattenChromeMcpRouteSnapshot,
} from "../chrome-mcp.snapshot-result.js";
import { DEFAULT_BROWSER_SCREENSHOT_TIMEOUT_MS } from "../constants.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
} from "../navigation-guard.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getLoadedPwAiModule } from "../pw-ai-module.js";
import { finalizeRoleSnapshot, type RoleRefMap } from "../pw-role-snapshot.js";
import type { BrowserObservedState } from "../pw-session-contracts.js";
import type { AnnotationItem } from "../screenshot-annotate.js";
import { scaleAnnotations } from "../screenshot-annotate.js";
import {
  DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
  normalizeBrowserScreenshot,
} from "../screenshot.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  getPreviousSnapshotKeys,
  recordSnapshotKeys,
  type SnapshotDeltaFamily,
} from "../snapshot-delta-cache.js";
import { appendSnapshotUrls } from "../snapshot-urls.js";
import { normalizeBrowserTimerDelayMs } from "../timer-delay.js";
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
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import {
  resolveSnapshotPlan,
  shouldUsePlaywrightForAriaSnapshot,
  shouldUsePlaywrightForScreenshot,
} from "./agent.snapshot.plan.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { readRoutePositiveInteger, readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, runProfileRouteOperation, toBoolean, toStringOrEmpty } from "./utils.js";

type ScreenshotCapture = {
  buffer: Buffer;
  labels?: number;
  skipped?: number;
  truncated?: boolean;
  annotations?: AnnotationItem[];
};

async function saveBrowserMedia(buffer: Buffer, contentType: string, maxBytes: number) {
  await ensureMediaDir();
  const saved = await saveMediaBuffer(buffer, contentType, "browser", maxBytes);
  return path.resolve(saved.path);
}

async function saveBrowserScreenshot(capture: ScreenshotCapture, type: "png" | "jpeg") {
  const normalized = await normalizeBrowserScreenshot(capture.buffer, {
    maxSide: DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE,
    maxBytes: DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  });
  const annotations = await rescaleAnnotationsForNormalization({
    annotations: capture.annotations,
    originalBuffer: capture.buffer,
    normalized,
  });
  const imagePath = await saveBrowserMedia(
    normalized.buffer,
    normalized.contentType ?? `image/${type}`,
    DEFAULT_BROWSER_SCREENSHOT_MAX_BYTES,
  );
  return {
    imagePath,
    imageType: normalized.contentType?.includes("jpeg") ? "jpeg" : type,
    ...(typeof capture.labels === "number" ? { labels: true, labelsCount: capture.labels } : {}),
    ...(typeof capture.skipped === "number" ? { labelsSkipped: capture.skipped } : {}),
    ...(capture.truncated ? { truncated: true } : {}),
    ...(annotations?.length ? { annotations } : {}),
  };
}

// Preserve original coordinates when image dimensions cannot be recovered.
async function rescaleAnnotationsForNormalization(params: {
  annotations?: AnnotationItem[];
  originalBuffer: Buffer;
  normalized: Awaited<ReturnType<typeof normalizeBrowserScreenshot>>;
}): Promise<AnnotationItem[] | undefined> {
  if (!params.annotations || params.annotations.length === 0) {
    return params.annotations;
  }
  const orig = params.normalized.sourceDimensions;
  // The normalizer already owns the source dimensions; identical bytes cannot rescale boxes.
  if (params.originalBuffer === params.normalized.buffer || !orig?.width || !orig?.height) {
    return params.annotations;
  }
  const next = await getImageMetadata(params.normalized.buffer);
  if (!next?.width || !next?.height) {
    return params.annotations;
  }
  if (next.width === orig.width && next.height === orig.height) {
    return params.annotations;
  }
  return scaleAnnotations(params.annotations, next.width / orig.width, next.height / orig.height);
}

/** Register snapshot, screenshot, and navigation endpoints. */
export function registerBrowserAgentSnapshotRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/navigate", async (req, res) => {
    const body = readBody(req);
    const url = toStringOrEmpty(body.url);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    if (!url) {
      return jsonError(res, 400, "url is required");
    }
    let timeoutMs: number | undefined;
    try {
      const requestedTimeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
      timeoutMs =
        requestedTimeoutMs === undefined
          ? undefined
          : resolveBrowserNavigationTimeoutMs(requestedTimeoutMs);
    } catch (err) {
      return jsonError(res, 400, String(err instanceof Error ? err.message : err));
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      run: async ({ profileCtx, tab, cdpUrl, signal, assertCurrent }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
          await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
          const result = await navigateChromeMcpPage({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            url,
            timeoutMs,
            signal,
          });
          await assertBrowserNavigationResultAllowed({ url: result.url, ...ssrfPolicyOpts });
          return res.json({ ok: true, targetId: tab.targetId, ...result });
        }
        const pw = await requirePwAi(res, "navigate");
        if (!pw) {
          return;
        }
        const resolveRelayTarget = await captureBrowserOperationTarget({
          ctx,
          profileName: profileCtx.profile.name,
          targetId: tab.targetId,
        });
        try {
          const result = await pw.navigateViaPlaywright({
            cdpUrl,
            targetId: tab.targetId,
            url,
            timeoutMs,
            ...(assertCurrent ? { assertCurrent } : {}),
            ...(resolveRelayTarget
              ? {
                  resolveOperationTarget: resolveRelayTarget,
                  relayReference: resolveRelayTarget.reference,
                }
              : {}),
            ...browserNavigationPolicyForProfile(ctx, profileCtx),
          });
          const currentTargetId = await resolveOperationTargetOutcome({
            actedOnTargetId: tab.targetId,
            operationTargetId: result.targetId,
            resolveRelayTarget,
          });
          res.json({ ok: true, ...result, targetId: currentTargetId });
        } finally {
          await resolveRelayTarget?.release();
        }
      },
    });
  });

  app.post("/pdf", async (req, res) => {
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
      profileCtx,
      targetId,
      feature: "pdf",
      enforceCurrentUrlAllowed: true,
      run: async ({ cdpUrl, tab, pw }) => {
        const pdf = await pw.pdfViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
        });
        const pdfPath = await saveBrowserMedia(
          pdf.buffer,
          "application/pdf",
          pdf.buffer.byteLength,
        );
        res.json({
          ok: true,
          path: pdfPath,
          targetId: tab.targetId,
          url: tab.url,
        });
      },
    });
  });

  app.post("/screenshot", async (req, res) => {
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
      run: async ({ profileCtx, tab, cdpUrl, signal }) => {
        const jsonScreenshot = (image: Awaited<ReturnType<typeof saveBrowserScreenshot>>) => {
          const { imagePath, imageType: _imageType, ...details } = image;
          res.json({ ok: true, path: imagePath, targetId: tab.targetId, url: tab.url, ...details });
        };
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          const operation: ChromeMcpSnapshotOperation = {
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            timeoutMs,
            signal,
          };
          const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: tab.url,
              ...ssrfPolicyOpts,
            });
          }
          if (element) {
            return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.screenshotElement);
          }
          if (labels) {
            const built = ref
              ? undefined
              : buildChromeMcpRouteSnapshot({ root: await takeChromeMcpSnapshot(operation) });
            const image = await withChromeMcpLabels(
              {
                ...operation,
                refs: ref ? [ref] : Object.keys(built?.refs ?? {}),
                clipToRef: Boolean(ref),
              },
              async (labelResult, capture) => {
                const buffer = await capture({ uid: ref, fullPage, format: type });
                return await saveBrowserScreenshot(
                  { buffer, ...labelResult, truncated: built?.truncated },
                  type,
                );
              },
            );
            return jsonScreenshot(image);
          }
          const buffer = await takeChromeMcpScreenshot({
            ...operation,
            uid: ref,
            fullPage,
            format: type,
          });
          jsonScreenshot(await saveBrowserScreenshot({ buffer }, type));
          return;
        }

        let capture: ScreenshotCapture;
        const shouldUsePlaywright =
          labels ||
          getLoadedPwAiModule()?.hasCachedPlaywrightBrowserConnection(cdpUrl) ||
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
          const snap =
            labels && !ref
              ? await pw.snapshotRoleViaPlaywright({
                  cdpUrl,
                  targetId: tab.targetId,
                  ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                  timeoutMs,
                  signal,
                })
              : undefined;
          const screenshotOptions: Parameters<typeof pw.takeScreenshotViaPlaywright>[0] = {
            cdpUrl,
            targetId: tab.targetId,
            ref,
            element,
            fullPage,
            type,
            timeoutMs,
            signal,
          };
          capture = labels
            ? await pw.screenshotWithLabelsViaPlaywright({ ...screenshotOptions, refs: snap?.refs })
            : await pw.takeScreenshotViaPlaywright(screenshotOptions);
        } else {
          const profileRuntime = ctx.state().profiles.get(profileCtx.profile.name);
          capture = {
            buffer: await captureScreenshot({
              wsUrl: tab.wsUrl ?? "",
              ...(tab.wsLookup ? { lookup: tab.wsLookup } : {}),
              fullPage,
              format: type,
              quality: type === "jpeg" ? 85 : undefined,
              timeoutMs,
              headless:
                profileRuntime?.running?.headless ??
                (await profileRuntime?.externalBrowserMode?.headless),
            }),
          };
        }

        jsonScreenshot(await saveBrowserScreenshot(capture, type));
      },
    });
  });

  app.get("/snapshot", async (req, res) => {
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
    const usesChromeMcp = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
    if ((plan.labels || plan.mode === "efficient") && plan.format === "aria") {
      return jsonError(res, 400, "labels/mode=efficient require format=ai");
    }
    if (usesChromeMcp && (plan.selectorValue || plan.frameSelectorValue)) {
      return jsonError(res, 400, EXISTING_SESSION_LIMITS.snapshot.snapshotSelector);
    }

    try {
      await runProfileRouteOperation({
        profileCtx,
        signal: req.signal,
        assertCurrent: req.assertCurrent,
        run: async (signal) => {
          const tab = await profileCtx.ensureTabAvailable(targetId || undefined, {
            allowPlaywrightFallback: hasPlaywright,
            signal,
            timeoutMs: plan.timeoutMs,
          });
          const ssrfPolicyOpts = browserNavigationPolicyForProfile(ctx, profileCtx);
          if (ssrfPolicyOpts.ssrfPolicy) {
            await assertBrowserNavigationResultAllowed({
              url: tab.url,
              ...ssrfPolicyOpts,
            });
          }
          await req.assertCurrent?.(profileCtx.profile);
          const jsonSnapshot = (snapshot: Record<string, unknown>) =>
            res.json({
              ok: true,
              format: plan.format,
              targetId: tab.targetId,
              url: tab.url,
              ...snapshot,
            });
          const deltaFamily: SnapshotDeltaFamily | undefined =
            plan.format === "ai"
              ? {
                  identity: usesChromeMcp
                    ? "aria"
                    : plan.wantsRoleSnapshot
                      ? plan.refsMode === "aria"
                        ? "aria"
                        : "role"
                      : pwModule
                        ? "aria"
                        : "role",
                  interactive: plan.interactive,
                  compact: plan.compact,
                  depth: plan.depth,
                  selector: plan.selectorValue,
                  frame: plan.frameSelectorValue,
                  urls: plan.urls,
                  maxChars: plan.resolvedMaxChars,
                }
              : undefined;
          const createDeltaState = (documentIdentity?: string) => {
            const previousKeys =
              deltaFamily && documentIdentity
                ? getPreviousSnapshotKeys(ctx, {
                    profile: profileCtx.profile.name,
                    targetId: tab.targetId,
                    documentIdentity,
                    family: deltaFamily,
                  })
                : undefined;
            return {
              delta:
                deltaFamily && previousKeys !== undefined
                  ? { mode: deltaFamily.identity, previousKeys }
                  : undefined,
              record: (refs: RoleRefMap) => {
                if (!deltaFamily || !documentIdentity) {
                  return;
                }
                recordSnapshotKeys(ctx, {
                  profile: profileCtx.profile.name,
                  targetId: tab.targetId,
                  documentIdentity,
                  family: deltaFamily,
                  refs,
                });
              },
            };
          };
          if (usesChromeMcp) {
            const operation: ChromeMcpSnapshotOperation = {
              profileName: profileCtx.profile.name,
              profile: profileCtx.profile,
              targetId: tab.targetId,
              timeoutMs: plan.timeoutMs,
              signal,
            };
            const snapshot = await takeChromeMcpSnapshot(operation);
            if (plan.format === "aria") {
              return jsonSnapshot(flattenChromeMcpRouteSnapshot(snapshot, plan.limit));
            }
            const built = buildChromeMcpRouteSnapshot({
              root: snapshot,
              options: {
                interactive: plan.interactive ?? undefined,
                compact: plan.compact ?? undefined,
                maxDepth: plan.depth ?? undefined,
              },
            });
            const builtWithUrls = plan.urls
              ? {
                  ...built,
                  snapshot: appendSnapshotUrls(
                    built.snapshot,
                    await collectChromeMcpSnapshotUrls(operation),
                  ),
                }
              : built;
            const finalizedBase = finalizeRoleSnapshot({
              ...builtWithUrls,
              maxChars: plan.resolvedMaxChars,
            });
            const finalized =
              built.truncated && !finalizedBase.truncated
                ? { ...finalizedBase, truncated: true }
                : finalizedBase;
            if (plan.labels) {
              const image = await withChromeMcpLabels(
                { ...operation, refs: Object.keys(finalized.refs) },
                async (labelResult, capture) => {
                  const buffer = await capture({ format: "png" });
                  return await saveBrowserScreenshot({ buffer, ...labelResult }, "png");
                },
              );
              return jsonSnapshot({ ...image, ...finalized });
            }
            return jsonSnapshot(finalized);
          }
          const readPlaywrightDocumentIdentities = pwModule?.getDocumentIdentitiesViaPlaywright;
          let observedBrowserState: BrowserObservedState | undefined;
          if (pwModule) {
            observedBrowserState = await pwModule
              .getObservedBrowserStateViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                ssrfPolicy: ctx.state().resolved.ssrfPolicy,
              })
              .catch(() => undefined);
          }
          const browserStateFields =
            observedBrowserState &&
            (observedBrowserState.dialogs.pending.length ||
              observedBrowserState.dialogs.recent.length)
              ? { browserState: observedBrowserState }
              : {};
          if (observedBrowserState?.dialogs.pending.length) {
            return jsonSnapshot({
              blockedByDialog: true,
              ...browserStateFields,
              ...(plan.format === "aria" ? { nodes: [] } : { snapshot: "", refs: {} }),
            });
          }
          const readDocumentIdentities = async (): Promise<CdpDocumentIdentities> => {
            const playwrightIdentities = readPlaywrightDocumentIdentities
              ? await readPlaywrightDocumentIdentities({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId: tab.targetId,
                  timeoutMs: plan.timeoutMs,
                }).catch(() => undefined)
              : undefined;
            if (playwrightIdentities?.mainFrame || !tab.wsUrl) {
              return playwrightIdentities ?? {};
            }
            return await getDocumentIdentitiesViaCdp({
              wsUrl: tab.wsUrl,
              ...(tab.wsLookup ? { lookup: tab.wsLookup } : {}),
              timeoutMs: plan.timeoutMs,
            }).catch(() => ({}));
          };
          const initialIdentities = await readDocumentIdentities();
          const initialDocumentIdentity = initialIdentities.mainFrame;
          const snapshotSpansFrames =
            plan.format === "ai" &&
            !plan.frameSelectorValue &&
            (plan.refsMode === "aria" || !pwModule || !plan.wantsRoleSnapshot);
          const deltaState = createDeltaState(
            snapshotSpansFrames || plan.frameSelectorValue
              ? initialIdentities.frameTree
              : initialDocumentIdentity,
          );
          const assertDocumentIdentityUnchanged = async () => {
            if (!initialDocumentIdentity) {
              return;
            }
            const finalIdentities = await readDocumentIdentities();
            if (
              finalIdentities.mainFrame !== initialDocumentIdentity ||
              (snapshotSpansFrames &&
                initialIdentities.frameTree &&
                finalIdentities.frameTree !== initialIdentities.frameTree)
            ) {
              throw new Error(
                "Frame changed while its browser snapshot was being captured; retry.",
              );
            }
          };
          if (plan.format === "ai") {
            const roleSnapshotArgs = {
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              selector: plan.selectorValue,
              frameSelector: plan.frameSelectorValue,
              refsMode: plan.refsMode,
              ssrfPolicy: ctx.state().resolved.ssrfPolicy,
              urls: plan.urls,
              timeoutMs: plan.timeoutMs,
              maxChars: plan.resolvedMaxChars,
              signal,
              options: {
                interactive: plan.interactive ?? undefined,
                compact: plan.compact ?? undefined,
                maxDepth: plan.depth ?? undefined,
              },
              delta: deltaState.delta,
            };

            const cdpRoleWsUrl =
              plan.refsMode !== "aria" && !plan.selectorValue && !plan.frameSelectorValue
                ? tab.wsUrl
                : null;
            let usedCdpRoleSnapshot = false;
            let cdpCaptureDeadlineMs: number | undefined;
            const cdpRoleSnapshot = async (recurseIframes = true) => {
              if (!cdpRoleWsUrl) {
                return null;
              }
              cdpCaptureDeadlineMs = performance.now() + (plan.timeoutMs ?? 5_000);
              const snapshot = await snapshotRoleViaCdp({
                wsUrl: cdpRoleWsUrl,
                ...(tab.wsLookup ? { lookup: tab.wsLookup } : {}),
                urls: plan.urls,
                recurseIframes,
                timeoutMs: plan.timeoutMs,
                maxChars: plan.resolvedMaxChars,
                options: {
                  interactive: plan.interactive ?? undefined,
                  compact: plan.compact ?? undefined,
                  maxDepth: plan.depth ?? undefined,
                },
                delta: deltaState.delta,
              });
              usedCdpRoleSnapshot = true;
              return snapshot;
            };

            const pw = pwModule;
            const cdpFirstPw = pw && plan.wantsRoleSnapshot && cdpRoleWsUrl ? pw : null;
            const snap = plan.wantsRoleSnapshot
              ? cdpFirstPw
                ? await cdpRoleSnapshot(false).catch(async () => {
                    signal.throwIfAborted();
                    return await cdpFirstPw.snapshotRoleViaPlaywright(roleSnapshotArgs);
                  })
                : pw
                  ? await pw.snapshotRoleViaPlaywright(roleSnapshotArgs)
                  : await cdpRoleSnapshot()
              : pw
                ? await pw.snapshotRoleViaPlaywright({
                    cdpUrl: profileCtx.profile.cdpUrl,
                    targetId: tab.targetId,
                    refsMode: "aria",
                    ssrfPolicy: ctx.state().resolved.ssrfPolicy,
                    urls: plan.urls,
                    timeoutMs: plan.timeoutMs,
                    signal,
                    ...(typeof plan.resolvedMaxChars === "number"
                      ? { maxChars: plan.resolvedMaxChars }
                      : {}),
                    delta: deltaState.delta,
                  })
                : await cdpRoleSnapshot();
            if (!snap) {
              await requirePwAi(res, "ai snapshot");
              return;
            }
            if (usedCdpRoleSnapshot && pw && "refs" in snap) {
              await assertDocumentIdentityUnchanged();
              await pw.storeSnapshotRefsViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                refs: snap.refs,
                signal,
                deadlineMs: cdpCaptureDeadlineMs,
                ...(initialDocumentIdentity
                  ? { expectedDocumentIdentity: initialDocumentIdentity }
                  : {}),
              });
            }
            let image: Awaited<ReturnType<typeof saveBrowserScreenshot>> | undefined;
            if (plan.labels) {
              if (!pw) {
                return jsonError(res, 501, "Snapshot labels require Playwright.");
              }
              const labeled = await pw.screenshotWithLabelsViaPlaywright({
                cdpUrl: profileCtx.profile.cdpUrl,
                targetId: tab.targetId,
                refs: "refs" in snap ? snap.refs : {},
                type: "png",
                timeoutMs: plan.timeoutMs,
                signal,
              });
              image = await saveBrowserScreenshot(labeled, "png");
            }

            await assertDocumentIdentityUnchanged();
            deltaState.record(snap.refs ?? {});
            return jsonSnapshot({
              ...browserStateFields,
              ...image,
              ...snap,
            });
          }

          const usePlaywrightAriaSnapshot = shouldUsePlaywrightForAriaSnapshot({
            profile: profileCtx.profile,
            wsUrl: tab.wsUrl,
          });
          let resolved: Awaited<ReturnType<typeof snapshotAria>>;
          if (usePlaywrightAriaSnapshot) {
            const pw = await requirePwAi(res, "aria snapshot");
            if (!pw) {
              return;
            }
            resolved = await pw.snapshotAriaViaPlaywright({
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              limit: plan.limit,
              timeoutMs: plan.timeoutMs,
              ssrfPolicy: ctx.state().resolved.ssrfPolicy,
              signal,
            });
          } else {
            const captureDeadlineMs = performance.now() + (plan.timeoutMs ?? 5_000);
            resolved = await snapshotAria({
              wsUrl: tab.wsUrl ?? "",
              ...(tab.wsLookup ? { lookup: tab.wsLookup } : {}),
              limit: plan.limit,
              timeoutMs: plan.timeoutMs,
            });
            await assertDocumentIdentityUnchanged();
            await pwModule?.storeSnapshotRefsViaPlaywright?.({
              cdpUrl: profileCtx.profile.cdpUrl,
              targetId: tab.targetId,
              nodes: resolved.nodes,
              signal,
              deadlineMs: captureDeadlineMs,
              ...(initialDocumentIdentity
                ? { expectedDocumentIdentity: initialDocumentIdentity }
                : {}),
            });
          }
          await assertDocumentIdentityUnchanged();
          return jsonSnapshot({
            ...browserStateFields,
            ...resolved,
          });
        },
      });
    } catch (err) {
      handleRouteError(ctx, res, err);
    }
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
