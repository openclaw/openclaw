/**
 * Browser agent action route registration and existing-session execution.
 *
 * Dispatches normalized actions to either Playwright-backed OpenClaw browser
 * control or Chrome MCP existing-session operations with navigation guards.
 */
import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { resolveExistingSessionActTimeouts } from "../act-policy.js";
import {
  clickChromeMcpElement,
  clickChromeMcpCoords,
  dragChromeMcpElement,
  evaluateChromeMcpScript,
  fillChromeMcpElement,
  fillChromeMcpForm,
  hoverChromeMcpElement,
  pressChromeMcpKey,
  resizeChromeMcpPage,
  type ChromeMcpOperationOptions,
} from "../chrome-mcp.js";
import type { BrowserActRequest } from "../client-actions.types.js";
import { normalizeBrowserEvaluateFunctionSource } from "../evaluate-source.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import type { BrowserRouteContext } from "../server-context.js";
import { clearSnapshotKeysForTab } from "../snapshot-delta-cache.js";
import { registerBrowserAgentActDownloadRoutes } from "./agent.act.download.js";
import {
  ACT_ERROR_CODES,
  browserEvaluateDisabledMessage,
  jsonActError,
} from "./agent.act.errors.js";
import {
  assertExistingSessionPostInteractionNavigationAllowed,
  createExistingSessionDeadline,
  waitForExistingSessionCondition,
  type ExistingSessionOperation,
} from "./agent.act.existing-session.js";
import { registerBrowserAgentActHookRoutes } from "./agent.act.hooks.js";
import { canonicalizeActTargetIds, normalizeActRequest } from "./agent.act.normalize.js";
import { type ActKind, isActKind } from "./agent.act.shared.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  resolveProfileContext,
  resolveTargetIdFromBody,
  resolveSafeRouteTabUrl,
  withRouteTabContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import {
  EXISTING_SESSION_LIMITS,
  getExistingSessionUnsupportedMessage,
} from "./existing-session-limits.js";
import { readRoutePositiveInteger, readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

const SELECTOR_ALLOWED_KINDS: ReadonlySet<string> = new Set([
  "batch",
  "click",
  "drag",
  "hover",
  "scrollIntoView",
  "select",
  "type",
  "wait",
]);

function shouldEnforceCurrentUrlForAct(action: BrowserActRequest): boolean {
  // Batch stays guarded because nested actions can read or return page data.
  return action.kind !== "resize" && action.kind !== "close";
}

/** Register browser action endpoints, including hook and download subroutes. */
export function registerBrowserAgentActRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/act", async (req, res) => {
    const body = readBody(req);
    const kindRaw = toStringOrEmpty(body.kind);
    if (!isActKind(kindRaw)) {
      return jsonActError(res, 400, ACT_ERROR_CODES.kindRequired, "kind is required");
    }
    const kind: ActKind = kindRaw;
    let action: BrowserActRequest;
    try {
      action = normalizeActRequest(body);
    } catch (err) {
      return jsonActError(res, 400, ACT_ERROR_CODES.invalidRequest, formatErrorMessage(err));
    }
    const targetId = resolveTargetIdFromBody(body);
    if (Object.hasOwn(body, "selector") && !SELECTOR_ALLOWED_KINDS.has(kind)) {
      return jsonActError(
        res,
        400,
        ACT_ERROR_CODES.selectorUnsupported,
        SELECTOR_UNSUPPORTED_MESSAGE,
      );
    }
    const earlyFn = action.kind === "wait" || action.kind === "evaluate" ? action.fn : "";
    if (
      (action.kind === "evaluate" || (action.kind === "wait" && earlyFn)) &&
      !ctx.state().resolved.evaluateEnabled
    ) {
      return jsonActError(
        res,
        403,
        ACT_ERROR_CODES.evaluateDisabled,
        browserEvaluateDisabledMessage(action.kind === "evaluate" ? "evaluate" : "wait"),
      );
    }

    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const isExistingSession = getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp;
    const existingSessionTimeouts = resolveExistingSessionActTimeouts(action);
    const requestDeadline = isExistingSession
      ? createExistingSessionDeadline(
          existingSessionTimeouts.requestTimeoutMs,
          req.signal,
          "Browser action request",
        )
      : undefined;
    try {
      await withRouteTabContext({
        req: requestDeadline ? { ...req, signal: requestDeadline.signal } : req,
        res,
        ctx,
        profileCtx,
        targetId,
        enforceCurrentUrlAllowed: shouldEnforceCurrentUrlForAct(action),
        run: async ({ cdpUrl, tab, signal, resolveTabUrl }) => {
          const evaluateEnabled = ctx.state().resolved.evaluateEnabled;
          const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
          let verificationDeadline: ReturnType<typeof createExistingSessionDeadline> | undefined;
          const existingSessionCallOptions: ChromeMcpOperationOptions = {
            timeoutMs: existingSessionTimeouts.timeoutMs,
            signal,
          };
          const hasNavigationResultPolicy = Boolean(
            navigationPolicy.ssrfPolicy || navigationPolicy.browserProxyMode,
          );
          let resolveRelayTarget: Awaited<ReturnType<typeof captureBrowserOperationTarget>>;
          try {
            requestDeadline?.throwIfAborted();
            resolveRelayTarget = await captureBrowserOperationTarget({
              ctx,
              profileName: profileCtx.profile.name,
              targetId: tab.targetId,
            });
            const jsonOk = async (
              extra?: Record<string, unknown>,
              options?: { resolveCurrentTarget?: boolean; operationTargetId?: string },
            ) => {
              const shouldResolveCurrentTarget =
                options?.resolveCurrentTarget && (!isExistingSession || hasNavigationResultPolicy);
              const responseTargetId = shouldResolveCurrentTarget
                ? await resolveOperationTargetOutcome({
                    actedOnTargetId: tab.targetId,
                    operationTargetId: options?.operationTargetId,
                    resolveRelayTarget,
                  })
                : tab.targetId;
              const url =
                !isExistingSession && responseTargetId === tab.targetId
                  ? await resolveTabUrl(tab.url)
                  : await resolveSafeRouteTabUrl({
                      ctx,
                      profileCtx,
                      targetId: responseTargetId,
                      fallbackUrl: tab.url,
                      ...(isExistingSession
                        ? {
                            ...existingSessionCallOptions,
                            timeoutMs:
                              responseTargetId === tab.targetId
                                ? ctx.state().resolved.actionTimeoutMs
                                : existingSessionCallOptions.timeoutMs,
                            signal: verificationDeadline?.signal ?? signal,
                          }
                        : {}),
                    });
              verificationDeadline?.throwIfAborted();
              requestDeadline?.throwIfAborted();
              if (isExistingSession) {
                signal.throwIfAborted();
              }
              return res.json({
                ok: true,
                targetId: responseTargetId,
                ...(url ? { url } : {}),
                ...extra,
              });
            };
            // Nested batch aliases can differ from the request alias, so prefixes
            // must stay unique across the full tab set before canonicalization.
            const actionTabs =
              action.kind === "batch" && !isExistingSession ? await profileCtx.listTabs() : [tab];
            if (!actionTabs.some((candidate) => candidate.targetId === tab.targetId)) {
              actionTabs.unshift(tab);
            }
            const targetIdError = canonicalizeActTargetIds(action, tab, actionTabs);
            if (targetIdError) {
              return jsonActError(res, 403, ACT_ERROR_CODES.targetIdMismatch, targetIdError);
            }
            const profileName = profileCtx.profile.name;
            if (isExistingSession) {
              const unsupportedMessage = getExistingSessionUnsupportedMessage(action);
              if (unsupportedMessage) {
                return jsonActError(
                  res,
                  501,
                  ACT_ERROR_CODES.unsupportedForExistingSession,
                  unsupportedMessage,
                );
              }
              const existingSessionTarget: ExistingSessionOperation = {
                profileName,
                profile: profileCtx.profile,
                targetId: tab.targetId,
                ...existingSessionCallOptions,
              };
              const initialTabTargetIds =
                hasNavigationResultPolicy && existingSessionTimeouts.verificationTimeoutMs > 0
                  ? new Set(
                      (await profileCtx.listTabs(existingSessionCallOptions)).map(
                        (currentTab) => currentTab.targetId,
                      ),
                    )
                  : new Set<string>();
              const runGuardedAction = async <T>(
                execute: (
                  target: ExistingSessionOperation,
                  checkDeadline: () => void,
                ) => Promise<T>,
              ): Promise<T> => {
                const bodyDeadline =
                  existingSessionTimeouts.bodyTimeoutMs === undefined
                    ? undefined
                    : createExistingSessionDeadline(
                        existingSessionTimeouts.bodyTimeoutMs,
                        signal,
                        "Browser action",
                      );
                const checkDeadline = () => {
                  requestDeadline?.throwIfAborted();
                  signal.throwIfAborted();
                  bodyDeadline?.throwIfAborted();
                };
                let outcome: { result: T } | { error: unknown };
                try {
                  checkDeadline();
                  const result = await execute(
                    { ...existingSessionTarget, signal: bodyDeadline?.signal ?? signal },
                    checkDeadline,
                  );
                  checkDeadline();
                  outcome = { result };
                } catch (error) {
                  outcome = {
                    error: bodyDeadline?.signal.aborted ? bodyDeadline.signal.reason : error,
                  };
                } finally {
                  bodyDeadline?.cleanup();
                }
                if (existingSessionTimeouts.verificationTimeoutMs > 0) {
                  verificationDeadline = createExistingSessionDeadline(
                    existingSessionTimeouts.verificationTimeoutMs,
                    signal,
                    "Browser navigation verification",
                  );
                  verificationDeadline.throwIfAborted();
                  const verificationOptions = {
                    ...existingSessionCallOptions,
                    signal: verificationDeadline.signal,
                  };
                  await assertExistingSessionPostInteractionNavigationAllowed({
                    ...existingSessionTarget,
                    ...verificationOptions,
                    ...navigationPolicy,
                    listTabs: () => profileCtx.listTabs(verificationOptions),
                    initialTabTargetIds,
                  });
                }
                if ("error" in outcome) {
                  throw toErrorObject(outcome.error, "Non-Error thrown");
                }
                return outcome.result;
              };
              switch (action.kind) {
                case "click":
                  await runGuardedAction((target) =>
                    clickChromeMcpElement({
                      ...target,
                      uid: action.ref!,
                      doubleClick: action.doubleClick ?? false,
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "clickCoords":
                  await runGuardedAction((target) =>
                    clickChromeMcpCoords({
                      ...target,
                      x: action.x,
                      y: action.y,
                      doubleClick: action.doubleClick ?? false,
                      button: action.button as "left" | "right" | "middle" | undefined,
                      delayMs: action.delayMs,
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "type":
                  await runGuardedAction(async (target, checkDeadline) => {
                    await fillChromeMcpElement({
                      ...target,
                      uid: action.ref!,
                      value: action.text,
                    });
                    if (action.submit) {
                      checkDeadline();
                      await pressChromeMcpKey({
                        ...target,
                        key: "Enter",
                      });
                    }
                  });
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "press":
                  await runGuardedAction((target) =>
                    pressChromeMcpKey({
                      ...target,
                      key: action.key,
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "hover":
                  await runGuardedAction((target) =>
                    hoverChromeMcpElement({
                      ...target,
                      uid: action.ref!,
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "scrollIntoView":
                  await runGuardedAction((target) =>
                    evaluateChromeMcpScript({
                      ...target,
                      fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
                      args: [action.ref!],
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "drag":
                  await runGuardedAction((target) =>
                    dragChromeMcpElement({
                      ...target,
                      fromUid: action.startRef!,
                      toUid: action.endRef!,
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "select":
                  await runGuardedAction((target) =>
                    fillChromeMcpElement({
                      ...target,
                      uid: action.ref!,
                      value: action.values[0] ?? "",
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "fill":
                  await runGuardedAction((target) =>
                    fillChromeMcpForm({
                      ...target,
                      elements: action.fields.map((field) => ({
                        uid: field.ref,
                        value: String(field.value ?? ""),
                      })),
                    }),
                  );
                  return await jsonOk(undefined, { resolveCurrentTarget: true });
                case "resize":
                  await runGuardedAction((target) =>
                    resizeChromeMcpPage({
                      ...target,
                      width: action.width,
                      height: action.height,
                    }),
                  );
                  return await jsonOk();
                case "wait":
                  await runGuardedAction((target) =>
                    waitForExistingSessionCondition({
                      ...target,
                      timeMs: action.timeMs,
                      text: action.text,
                      textGone: action.textGone,
                      selector: action.selector,
                      url: action.url,
                      loadState: action.loadState,
                      fn: action.fn,
                      ...navigationPolicy,
                    }),
                  );
                  return await jsonOk();
                case "evaluate": {
                  const result = await runGuardedAction((target) =>
                    evaluateChromeMcpScript({
                      ...target,
                      fn: normalizeBrowserEvaluateFunctionSource(
                        action.fn,
                        action.ref ? { argumentName: "el" } : undefined,
                      ),
                      args: action.ref ? [action.ref] : undefined,
                    }),
                  );
                  return await jsonOk({ result }, { resolveCurrentTarget: true });
                }
                case "close":
                  await runGuardedAction((target) =>
                    profileCtx.closeTab(tab.targetId, {
                      timeoutMs: target.timeoutMs,
                      signal: target.signal,
                      exactTargetId: true,
                    }),
                  );
                  clearSnapshotKeysForTab(ctx, profileCtx.profile.name, tab.targetId);
                  return await jsonOk();
                case "batch":
                  return jsonActError(
                    res,
                    501,
                    ACT_ERROR_CODES.unsupportedForExistingSession,
                    EXISTING_SESSION_LIMITS.act.batch,
                  );
              }
            }

            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            const result = await pw.executeActViaPlaywright({
              cdpUrl,
              action,
              targetId: tab.targetId,
              evaluateEnabled,
              ...navigationPolicy,
              signal,
            });
            const resultTargetOptions = {
              resolveCurrentTarget: true,
              operationTargetId: result.targetId,
            };
            if (result.blockedByDialog) {
              return await jsonOk({
                blockedByDialog: true,
                browserState: result.browserState,
              });
            }
            const downloads = result.downloads;
            if (action.kind === "close" || result.aborted?.reason === "closed") {
              clearSnapshotKeysForTab(ctx, profileCtx.profile.name, tab.targetId);
            }
            switch (action.kind) {
              case "batch":
                return await jsonOk(
                  {
                    results: result.results ?? [],
                    ...(result.aborted ? { aborted: result.aborted } : {}),
                    ...(downloads ? { downloads } : {}),
                  },
                  {
                    ...resultTargetOptions,
                    resolveCurrentTarget: result.aborted?.reason !== "closed",
                  },
                );
              case "evaluate":
                return await jsonOk(
                  { result: result.result, ...(downloads ? { downloads } : {}) },
                  resultTargetOptions,
                );
              case "click":
              case "clickCoords":
                return await jsonOk(downloads ? { downloads } : undefined, resultTargetOptions);
              case "resize":
              case "close":
                return await jsonOk(downloads ? { downloads } : undefined);
              default:
                return await jsonOk(downloads ? { downloads } : undefined, resultTargetOptions);
            }
          } catch (error) {
            verificationDeadline?.throwIfAborted();
            requestDeadline?.throwIfAborted();
            throw error;
          } finally {
            verificationDeadline?.cleanup();
            await resolveRelayTarget?.release();
          }
        },
      });
    } finally {
      requestDeadline?.cleanup();
    }
  });

  registerBrowserAgentActHookRoutes(app, ctx);
  registerBrowserAgentActDownloadRoutes(app, ctx);

  app.post("/response/body", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const url = toStringOrEmpty(body.url);
    let timeoutMs: number | undefined;
    let maxChars: number | undefined;
    try {
      timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs);
      maxChars = readRoutePositiveInteger(body.maxChars, "maxChars");
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }
    if (!url) {
      return jsonError(res, 400, "url is required");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab, signal, resolveTabUrl }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(res, 501, EXISTING_SESSION_LIMITS.responseBody);
        }
        const pw = await requirePwAi(res, "response body");
        if (!pw) {
          return;
        }
        const result = await pw.responseBodyViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          signal,
          url,
          timeoutMs: timeoutMs ?? undefined,
          maxChars: maxChars ?? undefined,
        });
        signal.throwIfAborted();
        const currentUrl = await resolveTabUrl(tab.url);
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(currentUrl ? { url: currentUrl } : {}),
          response: result,
        });
      },
    });
  });

  app.post("/highlight", async (req, res) => {
    const body = readBody(req);
    const targetId = resolveTargetIdFromBody(body);
    const ref = toStringOrEmpty(body.ref);
    if (!ref) {
      return jsonError(res, 400, "ref is required");
    }

    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab, signal, resolveTabUrl }) => {
        const jsonOk = async () => {
          const currentUrl = await resolveTabUrl(tab.url);
          return res.json({
            ok: true,
            targetId: tab.targetId,
            ...(currentUrl ? { url: currentUrl } : {}),
          });
        };
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          await evaluateChromeMcpScript({
            profileName: profileCtx.profile.name,
            profile: profileCtx.profile,
            targetId: tab.targetId,
            args: [ref],
            timeoutMs: ctx.state().resolved.actionTimeoutMs,
            signal,
            fn: `(el) => {
              if (!(el instanceof Element)) {
                return false;
              }
              el.scrollIntoView({ block: "center", inline: "center" });
              const previousOutline = el.style.outline;
              const previousOffset = el.style.outlineOffset;
              el.style.outline = "3px solid #FF4500";
              el.style.outlineOffset = "2px";
              setTimeout(() => {
                el.style.outline = previousOutline;
                el.style.outlineOffset = previousOffset;
              }, 2000);
              return true;
            }`,
          });
          return await jsonOk();
        }
        const pw = await requirePwAi(res, "highlight");
        if (!pw) {
          return;
        }
        await pw.highlightViaPlaywright({
          cdpUrl,
          targetId: tab.targetId,
          ref,
        });
        await jsonOk();
      },
    });
  });
}
