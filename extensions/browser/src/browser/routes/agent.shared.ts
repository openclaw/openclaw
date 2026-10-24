import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { redactCdpErrorText } from "../cdp.helpers.js";
import { toBrowserErrorResponse } from "../errors.js";
import { assertBrowserNavigationResultAllowed } from "../navigation-guard.js";
import { resolveBrowserNavigationPolicy } from "../navigation-policy.js";
import type { PwAiModule } from "../pw-ai-module.js";
import { getPwAiModule } from "../pw-ai-module.js";
import type { InteractionTargetOptions } from "../pw-tools-core.interactions.navigation.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { isProfileRestartRequiredError } from "../server-context.lifecycle.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import {
  getProfileContext,
  jsonBrowserError,
  jsonError,
  runProfileRouteOperation,
} from "./utils.js";

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

export function readBody(req: BrowserRequest): Record<string, unknown> {
  return asNonArrayRecord(req.body);
}

export function handleRouteError(
  res: BrowserResponse,
  err: unknown,
  options?: { formatMessage?: (err: unknown) => string; mapBrowserError?: boolean },
) {
  if (isProfileRestartRequiredError(err)) {
    throw err;
  }
  const browserMapped =
    options?.mapBrowserError === false ? undefined : toBrowserErrorResponse(err);
  if (browserMapped) {
    return jsonBrowserError(res, browserMapped);
  }
  jsonError(
    res,
    500,
    options?.formatMessage ? options.formatMessage(err) : redactCdpErrorText(String(err)),
  );
}

export function resolveProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

export function browserNavigationPolicyForProfile(
  ctx: BrowserRouteContext,
  profileCtx: ProfileContext,
) {
  return resolveBrowserNavigationPolicy(ctx.state(), profileCtx.profile);
}

/** Require Playwright support for a route feature, returning a 501 when absent. */
export async function requirePwAi(
  res: BrowserResponse,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule({ mode: "soft" });
  if (mod) {
    return mod;
  }
  jsonError(
    res,
    501,
    [
      `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
      "Reinstall or update OpenClaw so the core browser runtime dependency is present, then restart the gateway. In Docker, also install Chromium with the bundled playwright-core CLI.",
      "Docs: /tools/browser-control#playwright-requirement",
    ].join("\n"),
  );
  return null;
}

export type RouteTabContext = {
  profileCtx: ProfileContext;
  tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
  cdpUrl: string;
  signal: AbortSignal;
  assertCurrent?: InteractionTargetOptions["assertCurrent"];
  resolveTabUrl: (fallbackUrl?: string) => Promise<string | undefined>;
};

type RouteTabPwContext = RouteTabContext & {
  pw: PwAiModule;
};

type RouteWithTabParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  profileCtx?: ProfileContext;
  targetId?: string;
  /**
   * Set for routes that read from or return data scoped to the selected tab.
   * Leave false only for routes that navigate, activate, close, or otherwise manage the tab.
   */
  enforceCurrentUrlAllowed?: boolean;
  /** Reuse this request's admitted address only for response URL redaction. */
  reuseAdmittedUrlForResponse?: boolean;
  run: (ctx: RouteTabContext) => Promise<T>;
};

export async function withRouteTabContext<T>(
  params: RouteWithTabParams<T>,
): Promise<T | undefined> {
  const profileCtx = params.profileCtx ?? resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return undefined;
  }
  const requestAssertCurrent = params.req.assertCurrent;
  const assertCurrent = requestAssertCurrent
    ? () => requestAssertCurrent(profileCtx.profile)
    : undefined;
  try {
    return await runProfileRouteOperation({
      profileCtx,
      signal: params.req.signal,
      assertCurrent: params.req.assertCurrent,
      run: async (signal) => {
        // Agent routes can address local-managed tabs through Playwright when per-tab WS discovery lags.
        const tab = await profileCtx.ensureTabAvailable(params.targetId, {
          allowPlaywrightFallback: true,
          signal,
          timeoutMs: params.ctx.state().resolved.actionTimeoutMs,
        });
        let admittedNavigation: { url: string; policyKey: string } | undefined;
        if (params.enforceCurrentUrlAllowed) {
          const url = tab.url;
          const navigationPolicy = browserNavigationPolicyForProfile(params.ctx, profileCtx);
          const policyKey = JSON.stringify(navigationPolicy);
          await assertBrowserNavigationResultAllowed({
            url,
            signal,
            ...navigationPolicy,
          });
          if (params.reuseAdmittedUrlForResponse) {
            admittedNavigation = { url, policyKey };
          }
        }
        if (assertCurrent) {
          await assertCurrent();
        }
        return await params.run({
          profileCtx,
          tab,
          cdpUrl: profileCtx.profile.cdpUrl,
          signal,
          ...(assertCurrent ? { assertCurrent } : {}),
          resolveTabUrl: (fallbackUrl?: string) =>
            resolveSafeRouteTabUrl({
              ctx: params.ctx,
              profileCtx,
              targetId: tab.targetId,
              fallbackUrl,
              signal,
              timeoutMs: params.ctx.state().resolved.actionTimeoutMs,
              admittedNavigation,
            }),
        });
      },
    });
  } catch (err) {
    handleRouteError(params.res, err);
    return undefined;
  }
}

/**
 * Response-only URL redaction. This swallows policy failures and must not be used as
 * an execution gate; use enforceCurrentUrlAllowed on the route helper instead.
 */
export async function resolveSafeRouteTabUrl(params: {
  ctx: BrowserRouteContext;
  profileCtx: ProfileContext;
  targetId: string;
  fallbackUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  admittedNavigation?: { url: string; policyKey: string };
}): Promise<string | undefined> {
  let tabs: Array<{ targetId: string; url: string }>;
  try {
    tabs = await params.profileCtx.listTabs({ signal: params.signal, timeoutMs: params.timeoutMs });
  } catch {
    params.signal?.throwIfAborted();
    tabs = [];
  }
  const candidateUrl =
    tabs.find((tab) => tab.targetId === params.targetId)?.url ?? params.fallbackUrl;
  if (!candidateUrl) {
    return undefined;
  }
  try {
    params.signal?.throwIfAborted();
    const navigationPolicy = browserNavigationPolicyForProfile(params.ctx, params.profileCtx);
    // This only projects this request's already-admitted address. Actions and
    // navigation retain their own guards, even for a same-URL document reload.
    if (
      params.admittedNavigation?.url === candidateUrl &&
      params.admittedNavigation.policyKey === JSON.stringify(navigationPolicy)
    ) {
      // Policy fingerprints omit functions; retain the live authority check.
      navigationPolicy.assertNavigationCurrent?.();
      return candidateUrl;
    }
    await assertBrowserNavigationResultAllowed({
      url: candidateUrl,
      signal: params.signal,
      ...navigationPolicy,
    });
    return candidateUrl;
  } catch {
    params.signal?.throwIfAborted();
    return undefined;
  }
}

type RouteWithPwParams<T> = Omit<RouteWithTabParams<T>, "run"> & {
  feature: string;
  run: (ctx: RouteTabPwContext) => Promise<T>;
};

export async function withPlaywrightRouteContext<T>(
  params: RouteWithPwParams<T>,
): Promise<T | undefined> {
  const { run, feature, ...tabParams } = params;
  return await withRouteTabContext({
    ...tabParams,
    run: async (routeCtx) => {
      const pw = await requirePwAi(params.res, feature);
      if (!pw) {
        return undefined;
      }
      return await run({ ...routeCtx, pw });
    },
  });
}
