import crypto from "node:crypto";
import {
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { BrowserProfileUnavailableError } from "../errors.js";
import { assertBrowserNavigationResultAllowed } from "../navigation-guard.js";
import { DEFAULT_TRACE_DIR } from "../paths.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPwAiModule } from "../pw-ai-module.js";
import { mintBrowserScreencastToken } from "../screencast/tokens.js";
import type { BrowserRouteContext } from "../server-context.js";
import { getProfileLifecycle, isProfileOperationCurrent } from "../server-context.lifecycle.js";
import { registerBrowserAgentActRoutes } from "./agent.act.js";
import { createPlaywrightRouteRegistrar } from "./agent.playwright.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  withRouteTabContext,
} from "./agent.shared.js";
import { registerBrowserAgentSnapshotRoutes } from "./agent.snapshot.js";
import { registerBrowserAgentStorageRoutes } from "./agent.storage.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { EXISTING_SESSION_LIMITS } from "./existing-session-limits.js";
import { resolveWritableOutputPathOrRespond } from "./output-paths.js";
import { registerBrowserPermissionRoutes } from "./permissions.js";
import { withBrowserProfileCapabilities } from "./profile-capabilities.js";
import { readRoutePositiveInteger } from "./route-numeric.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { toBoolean } from "./utils.js";

function clampScreencastOption(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

export function registerBrowserRoutes(registrar: BrowserRouteRegistrar, ctx: BrowserRouteContext) {
  const app = withBrowserProfileCapabilities(registrar, ctx);
  registerBrowserBasicRoutes(app, ctx);
  registerBrowserTabRoutes(app, ctx);
  registerBrowserPermissionRoutes(app, ctx);
  registerBrowserAgentSnapshotRoutes(app, ctx);
  app.post("/screencast", async (req, res) => {
    const requesterGone = () => {
      if (!req.requester || req.requester.isCurrent()) {
        return false;
      }
      res.status(401).json({
        error: "The Gateway connection that requested the screencast has ended.",
        code: "SCREENCAST_REQUESTER_GONE",
      });
      return true;
    };
    if (requesterGone()) {
      return;
    }
    const body = readBody(req);
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId: normalizeOptionalString(body.targetId),
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, tab, cdpUrl, signal, resolveTabUrl }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          res.status(501).json({
            error: "Browser screencast is not available for existing-session profiles.",
            code: "SCREENCAST_UNSUPPORTED",
            reason: "existing-session",
          });
          return;
        }
        if (!(await getPwAiModule({ mode: "soft" }))) {
          res.status(501).json({
            error: "Browser screencast requires Playwright in this gateway build.",
            code: "SCREENCAST_UNSUPPORTED",
            reason: "playwright",
          });
          return;
        }
        const state = ctx.state();
        const profileName = profileCtx.profile.name;
        const runtime = state.profiles.get(profileName);
        if (!runtime) {
          throw new BrowserProfileUnavailableError("Browser profile is no longer available.");
        }
        const lifecycle = getProfileLifecycle(runtime);
        const profileSignal = lifecycle.controller.signal;
        const assertResourceCurrent = req.screencastAuthority?.assertCurrent;
        const assertCurrent = () => {
          assertResourceCurrent?.();
          if (
            state.profiles.get(profileName) !== runtime ||
            !isProfileOperationCurrent({ state, runtime, signal: profileSignal })
          ) {
            throw new BrowserProfileUnavailableError("Browser screencast target was superseded.");
          }
        };
        const url = await resolveTabUrl(tab.url);
        signal.throwIfAborted();
        assertCurrent();
        if (requesterGone()) {
          return;
        }
        const retainedRequester = req.screencastAuthority?.retainRequester();
        try {
          const { token, expiresAtMs } = mintBrowserScreencastToken({
            profileName,
            targetId: tab.targetId,
            cdpUrl,
            ssrfPolicy: state.resolved.ssrfPolicy,
            maxWidth: clampScreencastOption(body.maxWidth, 320, 2000, 1280),
            maxHeight: clampScreencastOption(body.maxHeight, 320, 2000, 1280),
            quality: clampScreencastOption(body.quality, 30, 90, 70),
            profileSignal,
            lifecycleSignal: req.screencastAuthority
              ? AbortSignal.any([lifecycle.controller.signal, req.screencastAuthority.signal])
              : lifecycle.controller.signal,
            requesterSignal: retainedRequester?.signal ?? req.requester?.signal,
            isRequesterCurrent: retainedRequester?.isCurrent ?? req.requester?.isCurrent,
            releaseRequester: retainedRequester?.release,
            assertCurrent,
            checkNavigationAllowed: async (nextUrl) => {
              await assertBrowserNavigationResultAllowed({
                url: nextUrl,
                ...browserNavigationPolicyForProfile(ctx, profileCtx),
              });
            },
          });
          res.json({
            token,
            wsPath: `/browser/screencast?token=${token}`,
            expiresAtMs,
            targetId: tab.targetId,
            url,
          });
        } catch (error) {
          retainedRequester?.release();
          throw error;
        }
      },
    });
  });
  registerBrowserAgentActRoutes(app, ctx);
  const register = createPlaywrightRouteRegistrar(app, ctx, "inspection");

  register("get", "/console", "console messages", (input) => {
    const level = normalizeOptionalString(typeof input.level === "string" ? input.level : "");
    return async (pw, { cdpUrl, targetId }) => ({
      messages: await pw.getConsoleMessagesViaPlaywright({ cdpUrl, targetId, level }),
    });
  });

  register(
    "get",
    "/errors",
    "page errors",
    (input) => {
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getPageErrorsViaPlaywright({ cdpUrl, targetId, clear });
    },
    EXISTING_SESSION_LIMITS.errors,
  );

  register(
    "get",
    "/requests",
    "network requests",
    (input) => {
      const filter = normalizeOptionalString(typeof input.filter === "string" ? input.filter : "");
      const clear = toBoolean(input.clear) ?? false;
      return (pw, { cdpUrl, targetId }) =>
        pw.getNetworkRequestsViaPlaywright({ cdpUrl, targetId, filter, clear });
    },
    EXISTING_SESSION_LIMITS.requests,
  );

  register(
    "get",
    "/text",
    "page text",
    (input) => {
      const selector = normalizeOptionalString(input.selector);
      const maxChars = readRoutePositiveInteger(input.maxChars, "maxChars");
      return (pw, target, signal) =>
        pw.getPageTextViaPlaywright({ ...target, signal, selector, maxChars });
    },
    EXISTING_SESSION_LIMITS.text,
  );

  register("get", "/dialogs", "dialog state", () => async (pw, { cdpUrl, targetId }) => ({
    browserState: await pw.getObservedBrowserStateViaPlaywright({
      cdpUrl,
      targetId,
      ssrfPolicy: ctx.state().resolved.ssrfPolicy,
    }),
  }));

  register("post", "/trace/start", "trace start", (input) => {
    const screenshots = toBoolean(input.screenshots);
    const snapshots = toBoolean(input.snapshots);
    const sources = toBoolean(input.sources);
    return async (pw, { cdpUrl, targetId }) => {
      await pw.traceStartViaPlaywright({ cdpUrl, targetId, screenshots, snapshots, sources });
      return {};
    };
  });

  register("post", "/trace/stop", "trace stop", (input, _params, res) => {
    const requestedPath = readNonBlankString(input.path) ?? "";
    return async (pw, { cdpUrl, targetId }) => {
      const tracePath = await resolveWritableOutputPathOrRespond({
        res,
        rootDir: DEFAULT_TRACE_DIR,
        requestedPath,
        scopeLabel: "trace directory",
        defaultFileName: `browser-trace-${crypto.randomUUID()}.zip`,
        ensureRootDir: true,
      });
      if (!tracePath) {
        return null;
      }
      return { path: await pw.traceStopViaPlaywright({ cdpUrl, targetId, path: tracePath }) };
    };
  });
  registerBrowserAgentStorageRoutes(app, ctx);
}
