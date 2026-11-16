import { formatErrorMessage } from "openclaw/plugin-sdk/security-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCdpControlPolicy } from "../cdp-reachability-policy.js";
import { withCdpSocket } from "../cdp.helpers.js";
import { getChromeWebSocketEndpoint } from "../chrome.js";
import { BrowserProfileUnavailableError } from "../errors.js";
import { getPwAiModule } from "../pw-ai-module.js";
import {
  assertInteractionCurrent,
  BrowserInteractionAuthorityError,
} from "../pw-tools-core.interactions.navigation.js";
import type { BrowserRouteContext } from "../server-context.js";
import { handleRouteError, readBody, resolveProfileContext } from "./agent.shared.js";
import { readRouteTimerTimeoutMs } from "./route-numeric.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, readHttpOrigin, runProfileRouteOperation, toStringOrEmpty } from "./utils.js";

function readPermissions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const permissions = raw
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (permissions.length !== raw.length) {
    return null;
  }
  return uniqueStrings(permissions);
}

function toPlaywrightPermission(permission: string): string | undefined {
  switch (permission) {
    case "audioCapture":
      return "microphone";
    case "videoCapture":
      return "camera";
    default:
      return undefined;
  }
}

export function registerBrowserPermissionRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
) {
  app.post("/permissions/grant", async (req, res) => {
    const body = readBody(req);
    const origin = readHttpOrigin(body.origin);
    if (!origin) {
      return jsonError(res, 400, "origin must be an http(s) origin");
    }
    const requiredPermissions = readPermissions(body.permissions);
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return jsonError(res, 400, "permissions must be a non-empty string array");
    }
    const optionalPermissions = readPermissions(body.optionalPermissions ?? []) ?? [];
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    let timeoutMs: number;
    try {
      timeoutMs = readRouteTimerTimeoutMs(body.timeoutMs, { minMs: 1_000 }) ?? 5_000;
    } catch (err) {
      return jsonError(res, 400, formatErrorMessage(err));
    }

    const profileCtx = resolveProfileContext(req, res, ctx);
    if (!profileCtx) {
      return;
    }
    const requestAssertCurrent = req.assertCurrent;
    const assertCurrent = requestAssertCurrent
      ? () => requestAssertCurrent(profileCtx.profile)
      : undefined;

    try {
      const granted = await runProfileRouteOperation({
        profileCtx,
        signal: req.signal,
        assertCurrent: req.assertCurrent,
        run: async (signal) => {
          await profileCtx.ensureBrowserAvailable({ signal });
          const cdpPolicy = resolveCdpControlPolicy(
            profileCtx.profile,
            ctx.state().resolved.ssrfPolicy,
          );
          const endpoint = await getChromeWebSocketEndpoint(
            profileCtx.profile.cdpUrl,
            timeoutMs,
            cdpPolicy,
          );
          signal.throwIfAborted();
          if (!endpoint) {
            throw new BrowserProfileUnavailableError("browser CDP WebSocket unavailable");
          }
          const wsUrl = endpoint.url;
          const wsLookup = endpoint.lookup;
          signal.throwIfAborted();
          const allPermissions = [...new Set([...requiredPermissions, ...optionalPermissions])];
          const playwrightRequiredPermissions = requiredPermissions.map(toPlaywrightPermission);
          if (playwrightRequiredPermissions.every((value): value is string => Boolean(value))) {
            const pw = await getPwAiModule({ mode: "soft" });
            if (pw) {
              try {
                const page = await pw.getPageForTargetId({
                  cdpUrl: profileCtx.profile.cdpUrl,
                  targetId,
                  ssrfPolicy: cdpPolicy,
                });
                if (assertCurrent) {
                  await assertInteractionCurrent({ assertCurrent });
                  signal.throwIfAborted();
                }
                await page.context().grantPermissions(playwrightRequiredPermissions, {
                  origin,
                });
                return {
                  grantedPermissions: requiredPermissions,
                  unsupportedPermissions: optionalPermissions,
                  grantMethod: "playwright",
                };
              } catch (error) {
                if (error instanceof BrowserInteractionAuthorityError) {
                  throw error;
                }
                signal.throwIfAborted();
                // Fall back to the raw CDP browser command below. Some routes call this
                // before a page exists, while attached browser profiles need Playwright.
              }
            }
          }
          signal.throwIfAborted();
          let unsupportedPermissions: string[] = [];
          await withCdpSocket(
            wsUrl,
            async (send) => {
              for (const permissions of [allPermissions, requiredPermissions]) {
                if (assertCurrent) {
                  await assertInteractionCurrent({ assertCurrent });
                  signal.throwIfAborted();
                }
                try {
                  await send("Browser.grantPermissions", { origin, permissions });
                  unsupportedPermissions =
                    permissions === allPermissions ? [] : optionalPermissions;
                  return;
                } catch (error) {
                  if (permissions !== allPermissions || optionalPermissions.length === 0) {
                    throw error;
                  }
                }
              }
            },
            { commandTimeoutMs: timeoutMs, lookup: wsLookup, signal },
          );
          signal.throwIfAborted();
          return {
            grantedPermissions: allPermissions.filter(
              (value) => !unsupportedPermissions.includes(value),
            ),
            unsupportedPermissions,
            grantMethod: "cdp",
          };
        },
      });
      return res.json({ ok: true, origin, ...granted });
    } catch (error) {
      return handleRouteError(res, error, {
        formatMessage: (err) => (err instanceof Error ? err.message : String(err)),
      });
    }
  });
}
