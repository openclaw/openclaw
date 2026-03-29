/**
 * Proxy-ingress route for transparent Telegram proxy mode.
 *
 * Accepts raw Telegram Update JSON via gateway-authenticated POST and feeds
 * it into a cached, ingress-only grammY bot instance using `bot.handleUpdate()`.
 *
 * The outer bot (OpenClawBoxBot) forwards raw updates to this endpoint instead
 * of transforming them into `/v1/responses` API calls.
 *
 * Route: POST /api/channels/telegram/proxy-ingress
 * Auth:  gateway (bearer token validated by the plugin HTTP route layer)
 * Body:  raw Telegram Update JSON (as received by the outer bot)
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBot } from "./bot.js";
import { resolveTelegramTransport } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";
import { getTelegramRuntime } from "./runtime.js";

const log = createSubsystemLogger("telegram/proxy-ingress");

/**
 * Cached ingress-only bot instances keyed by accountId.
 * Each bot is created once, initialized (bot.init()), and reused for all
 * incoming proxy updates for that account.
 */
const ingressBotCache = new Map<
  string,
  { bot: ReturnType<typeof createTelegramBot>; ready: Promise<void> }
>();

/**
 * Get or create an ingress-only bot instance for the given account.
 * The bot is created with `createTelegramBot()` (full middleware stack) and
 * `bot.init()` is called to fetch bot info from the Telegram API.
 *
 * Unlike the polling/webhook flow, this does NOT call `bot.start()` or
 * `setWebhook`/`deleteWebhook`. The bot instance only processes updates
 * pushed into it via `bot.handleUpdate()`.
 */
function getOrCreateIngressBot(accountId: string): {
  bot: ReturnType<typeof createTelegramBot>;
  ready: Promise<void>;
} {
  const cached = ingressBotCache.get(accountId);
  if (cached) {
    return cached;
  }

  const runtime = getTelegramRuntime();
  const cfg = runtime.config.loadConfig();
  const account = resolveTelegramAccount({ cfg, accountId });

  if (account.tokenSource === "none" || !account.token) {
    throw new Error(`No Telegram token available for account "${accountId}"`);
  }

  const proxyUrl = account.config.proxy?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const telegramTransport = resolveTelegramTransport(proxyFetch, {
    network: account.config.network,
  });

  const bot = createTelegramBot({
    token: account.token,
    accountId: account.accountId,
    config: cfg,
    telegramTransport,
  });

  // bot.init() fetches bot info (username, id) from the Telegram API.
  // We do NOT call bot.start() — no polling, no webhooks.
  const ready = bot.init().then(() => {
    log.info(`proxy-ingress bot initialized for account "${accountId}" (@${bot.botInfo.username})`);
  });

  const entry = { bot, ready };
  ingressBotCache.set(accountId, entry);
  return entry;
}

/**
 * Read and parse JSON body from an IncomingMessage.
 * Simple implementation since the plugin route layer already handles auth.
 */
async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        resolve({ ok: false, error: "payload too large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const data = JSON.parse(raw);
        resolve({ ok: true, data });
      } catch {
        resolve({ ok: false, error: "invalid JSON" });
      }
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: `read error: ${err.message}` });
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Maximum size for a raw Telegram update (generous: updates can include inline data). */
const MAX_UPDATE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Create the proxy-ingress HTTP handler.
 *
 * Route: POST /api/channels/telegram/proxy-ingress
 *
 * Query params:
 *   ?account=<accountId>  — optional, defaults to the default account
 *
 * Body: raw Telegram Update JSON object
 *
 * Returns:
 *   200 { ok: true }             — update was accepted and processed
 *   400 { error: { message } }   — invalid request body
 *   405                          — method not allowed
 *   500 { error: { message } }   — processing failed
 */
export function createProxyIngressHandler(
  _api: OpenClawPluginApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const ROUTE_PATH = "/api/channels/telegram/proxy-ingress";

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    // Only handle exact path match
    if (url.pathname !== ROUTE_PATH) {
      return false; // not our route
    }

    // POST only
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { error: { message: "Method Not Allowed" } });
      return true;
    }

    // Read body
    const bodyResult = await readJsonBody(req, MAX_UPDATE_BYTES);
    if (!bodyResult.ok) {
      sendJson(res, 400, { error: { message: bodyResult.error } });
      return true;
    }

    const update = bodyResult.data;
    if (!update || typeof update !== "object") {
      sendJson(res, 400, { error: { message: "Request body must be a JSON object" } });
      return true;
    }

    // Resolve account from query param (optional)
    const accountId = url.searchParams.get("account") ?? undefined;

    try {
      const { bot, ready } = getOrCreateIngressBot(accountId ?? "default");
      await ready;
      await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`proxy-ingress error (account=${accountId ?? "default"}): ${message}`);
      sendJson(res, 500, { error: { message: "Failed to process update" } });
    }

    return true;
  };
}

/**
 * Clear all cached ingress bot instances.
 * Exported for testing and cleanup.
 */
export function clearIngressBotCache(): void {
  ingressBotCache.clear();
}
