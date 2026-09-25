import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  selectChromeMcpOption,
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
import { isActKind } from "./agent.act.shared.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  requirePwAi,
  resolveProfileContext,
  resolveSafeRouteTabUrl,
  withRouteTabContext,
  SELECTOR_UNSUPPORTED_MESSAGE,
} from "./agent.shared.js";
import {
  captureBrowserOperationTarget,
  resolveOperationTargetOutcome,
} from "./agent.snapshot-target.js";
import { EXISTING_SESSION_LIMITS, admitExistingSessionAction } from "./existing-session-limits.js";
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

export function registerBrowserAgentActRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/act", async (req, res) => {
    const body = readBody(req);
    const kind = toStringOrEmpty(body.kind);
    if (!isActKind(kind)) {
      return jsonActError(res, 400, ACT_ERROR_CODES.kindRequired, "kind is required");
    }
    let action: BrowserActRequest;
    try {
      action = normalizeActRequest(body);
    } catch (err) {
      return jsonActError(res, 400, ACT_ERROR_CODES.invalidRequest, formatErrorMessage(err));
    }
    const targetId = normalizeOptionalString(body.targetId);
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
        // Batch stays guarded because nested actions can read or return page data.
        enforceCurrentUrlAllowed: action.kind !== "resize" && action.kind !== "close",
        run: async ({ cdpUrl, tab, signal, resolveTabUrl, assertCurrent }) => {
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
              const admission = admitExistingSessionAction(action);
              if (!admission.ok) {
                return jsonActError(
                  res,
                  501,
                  ACT_ERROR_CODES.unsupportedForExistingSession,
                  admission.error,
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
              const admittedAction = admission.action;
              const result = await runGuardedAction(async (target, checkDeadline) => {
                switch (admittedAction.kind) {
                  case "click":
                    return await clickChromeMcpElement({
                      ...target,
                      uid: admittedAction.ref!,
                      doubleClick: admittedAction.doubleClick ?? false,
                    });
                  case "clickCoords":
                    return await clickChromeMcpCoords({
                      ...target,
                      x: admittedAction.x,
                      y: admittedAction.y,
                      doubleClick: admittedAction.doubleClick ?? false,
                    });
                  case "type":
                    await fillChromeMcpElement({
                      ...target,
                      uid: admittedAction.ref!,
                      value: admittedAction.text,
                    });
                    if (admittedAction.submit) {
                      checkDeadline();
                      await pressChromeMcpKey({ ...target, key: "Enter" });
                    }
                    return undefined;
                  case "press":
                    return await pressChromeMcpKey({ ...target, key: admittedAction.key });
                  case "hover":
                    return await hoverChromeMcpElement({ ...target, uid: admittedAction.ref! });
                  case "scrollIntoView":
                    return await evaluateChromeMcpScript({
                      ...target,
                      fn: `(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }`,
                      args: [admittedAction.ref!],
                    });
                  case "drag":
                    return await dragChromeMcpElement({
                      ...target,
                      fromUid: admittedAction.startRef!,
                      toUid: admittedAction.endRef!,
                    });
                  case "select":
                    return await selectChromeMcpOption({
                      ...target,
                      uid: admittedAction.ref!,
                      value: admittedAction.values[0] ?? "",
                    });
                  case "fill":
                    return await fillChromeMcpForm({
                      ...target,
                      elements: admittedAction.fields.map((field) => ({
                        uid: field.ref,
                        value: String(field.value ?? ""),
                      })),
                    });
                  case "resize":
                    return await resizeChromeMcpPage({
                      ...target,
                      width: admittedAction.width,
                      height: admittedAction.height,
                    });
                  case "wait":
                    return await waitForExistingSessionCondition({
                      ...target,
                      timeMs: admittedAction.timeMs,
                      text: admittedAction.text,
                      textGone: admittedAction.textGone,
                      selector: admittedAction.selector,
                      url: admittedAction.url,
                      loadState: admittedAction.loadState,
                      fn: admittedAction.fn,
                      ...navigationPolicy,
                    });
                  case "evaluate":
                    return await evaluateChromeMcpScript({
                      ...target,
                      fn: normalizeBrowserEvaluateFunctionSource(
                        admittedAction.fn,
                        admittedAction.ref ? { argumentName: "el" } : undefined,
                      ),
                      args: admittedAction.ref ? [admittedAction.ref] : undefined,
                    });
                  case "close":
                    return await profileCtx.closeTab(tab.targetId, {
                      timeoutMs: target.timeoutMs,
                      signal: target.signal,
                      exactTargetId: true,
                    });
                }
                return undefined;
              });
              if (admittedAction.kind === "close") {
                clearSnapshotKeysForTab(ctx, profileCtx.profile.name, tab.targetId);
              }
              return await jsonOk(admittedAction.kind === "evaluate" ? { result } : undefined, {
                resolveCurrentTarget:
                  admittedAction.kind !== "resize" &&
                  admittedAction.kind !== "wait" &&
                  admittedAction.kind !== "close",
              });
            }

            const pw = await requirePwAi(res, `act:${kind}`);
            if (!pw) {
              return;
            }
            if (assertCurrent) {
              await assertCurrent();
            }
            const result = await pw.executeActViaPlaywright({
              cdpUrl,
              action,
              targetId: tab.targetId,
              evaluateEnabled,
              ...navigationPolicy,
              signal,
              ...(assertCurrent ? { assertCurrent } : {}),
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
    const targetId = normalizeOptionalString(body.targetId);
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
    const targetId = normalizeOptionalString(body.targetId);
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
