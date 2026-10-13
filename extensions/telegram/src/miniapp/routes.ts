import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  issueDeviceBootstrapToken,
} from "openclaw/plugin-sdk/device-bootstrap";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createFixedWindowRateLimiter,
  resolveRequestClientIp,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { readJsonWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveTelegramAccount } from "../accounts.js";
import { validateTelegramMiniAppInitData } from "./init-data.js";
import { pruneExpiredMiniAppEntries, type TelegramMiniAppLaunchTickets } from "./launch-ticket.js";
import { isTelegramMiniAppOwner } from "./owner.js";
import { renderTelegramMiniAppPage, TELEGRAM_MINIAPP_EXPIRED_MESSAGE } from "./page.js";
import {
  resolveTelegramMiniAppUrls,
  TELEGRAM_MINIAPP_PATH_PREFIX,
  TELEGRAM_MINIAPP_URL_ERROR,
} from "./url.js";

const AUTH_PATH = `${TELEGRAM_MINIAPP_PATH_PREFIX}auth`;
const MAX_BODY_BYTES = 4096;
const REPLAY_CACHE_LIMIT = 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const replayCache = new Map<string, number>();
const rateLimit = createFixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});

export function registerTelegramMiniAppRoutes(
  api: OpenClawPluginApi,
  launchTickets: TelegramMiniAppLaunchTickets,
): void {
  api.registerHttpRoute({
    path: TELEGRAM_MINIAPP_PATH_PREFIX,
    match: "prefix",
    auth: "plugin",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "", "http://openclaw.local");
      if (url.pathname === TELEGRAM_MINIAPP_PATH_PREFIX) {
        await handlePage(req, res, url);
      } else if (url.pathname === AUTH_PATH) {
        await handleAuth(api, launchTickets, req, res);
      } else {
        sendResponse(res, 404, "Not found");
      }
      return true;
    },
  });
}

async function handlePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method !== "GET") {
    return sendResponse(res, 405, "Method not allowed");
  }
  const accountId = normalizeAccountId(url.searchParams.get("accountId") ?? DEFAULT_ACCOUNT_ID);
  const nonce = crypto.randomBytes(16).toString("base64url");
  sendResponse(
    res,
    200,
    renderTelegramMiniAppPage({ accountId, scriptNonce: nonce }),
    "text/html",
    {
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
    },
  );
}

async function handleAuth(
  api: OpenClawPluginApi,
  launchTickets: TelegramMiniAppLaunchTickets,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST") {
    return sendResponse(res, 405, "Method not allowed");
  }
  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.split(";")[0]?.trim() !== "application/json") {
    return sendResponse(res, 415, "Unsupported media type");
  }
  const currentConfig = () => (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
  const requestConfig = currentConfig();
  const ip =
    resolveRequestClientIp(
      req,
      requestConfig.gateway?.trustedProxies,
      requestConfig.gateway?.allowRealIpFallback === true,
    ) ?? "unknown";
  if (rateLimit.isRateLimited(ip)) {
    return sendResponse(res, 429, "Too many requests");
  }

  const body = await readJsonWebhookBodyOrReject({
    req,
    res,
    maxBytes: MAX_BODY_BYTES,
    profile: "pre-auth",
    emptyObjectOnEmpty: false,
    invalidJsonMessage: TELEGRAM_MINIAPP_EXPIRED_MESSAGE,
    invalidJsonStatusCode: 401,
  });
  if (!body.ok) {
    return;
  }
  const authBody = body.value;
  if (
    !isRecord(authBody) ||
    typeof authBody.initData !== "string" ||
    typeof authBody.launchTicket !== "string"
  ) {
    return sendResponse(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
  }
  const accountId = normalizeAccountId(
    typeof authBody.accountId === "string" ? authBody.accountId : DEFAULT_ACCOUNT_ID,
  );
  const cfg = currentConfig();
  const account = resolveTelegramAccount({ cfg, accountId });
  const validated = validateTelegramMiniAppInitData({
    initData: authBody.initData,
    botToken: account.token,
  });
  if (!validated) {
    return sendResponse(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
  }
  if (!(await isTelegramMiniAppOwner({ cfg, accountId, userId: validated.userId }))) {
    return sendResponse(res, 403, "Restricted to the bot owner.");
  }

  let urls;
  try {
    urls = await resolveTelegramMiniAppUrls({ cfg });
  } catch {
    return sendResponse(res, 503, TELEGRAM_MINIAPP_URL_ERROR);
  }
  if (!(await isTelegramMiniAppOwner({ cfg, accountId, userId: validated.userId }))) {
    return sendResponse(res, 403, "Restricted to the bot owner.");
  }
  const authorityChanged = new Error("Telegram Mini App owner configuration changed");
  const assertCurrent = () => {
    if (currentConfig() !== cfg) {
      throw authorityChanged;
    }
  };
  try {
    assertCurrent();
    if (
      !launchTickets.consume({
        ticket: authBody.launchTicket,
        accountId,
        userId: validated.userId,
      })
    ) {
      return sendResponse(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    }
    if (!rememberReplay(validated.hash, validated.authDateMs + 300_000)) {
      return sendResponse(res, 401, TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    }
    const issued = await issueDeviceBootstrapToken({
      assertCurrent,
      profile: {
        roles: ["operator"],
        scopes: BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
        purpose: "control-ui",
      },
    });
    assertCurrent();
    sendResponse(
      res,
      200,
      JSON.stringify({
        bootstrapToken: issued.token,
        controlUiUrl: urls.controlUiUrl,
        gatewayUrl: urls.gatewayUrl,
      }),
      "application/json",
    );
  } catch (error) {
    if (error !== authorityChanged) {
      throw error;
    }
    sendResponse(res, 403, "Restricted to the bot owner.");
  }
}

function rememberReplay(hash: string, expiresAtMs: number): boolean {
  pruneExpiredMiniAppEntries(replayCache, (expires) => expires);
  if (replayCache.has(hash)) {
    return false;
  }
  replayCache.set(hash, expiresAtMs);
  pruneMapToMaxSize(replayCache, REPLAY_CACHE_LIMIT);
  return true;
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain",
  headers?: Record<string, string>,
): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Content-Type": `${contentType}; charset=utf-8`,
    ...headers,
  });
  res.end(body);
}
