import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { resolveDailyflowsAccount, resolveDailyflowsWebhookSecret } from "./config.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body) as Record<string, unknown>;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function buildUnpairConfigUpdate(params: {
  current: Record<string, unknown>;
  accountId: string;
}) {
  const next = { ...params.current } as Record<string, unknown>;
  const channels = { ...(next.channels as Record<string, unknown> | undefined) };
  const dailyflows = {
    ...(channels.dailyflows as Record<string, unknown> | undefined),
  };
  const accounts = {
    ...(dailyflows.accounts as Record<string, unknown> | undefined),
  };
  const account = {
    ...(accounts[params.accountId] as Record<string, unknown> | undefined),
  };

  account.enabled = false;
  delete account.webhookSecret;
  delete account.outboundToken;
  delete account.outboundUrl;

  accounts[params.accountId] = account;
  dailyflows.accounts = accounts;
  channels.dailyflows = dailyflows;
  next.channels = channels;

  return next;
}

function isUnpairAuthorized(params: {
  cfg: Record<string, unknown>;
  accountId: string;
  outboundToken?: string;
  webhookSecret?: string;
}) {
  const cfg = params.cfg as unknown as OpenClawConfig;
  const account = resolveDailyflowsAccount(cfg, params.accountId);
  const expectedToken = account.outboundToken?.trim() ?? "";
  const expectedSecret =
    resolveDailyflowsWebhookSecret({ cfg, accountId: params.accountId }) ?? "";
  const tokenOk =
    expectedToken && params.outboundToken && params.outboundToken.trim() === expectedToken;
  const secretOk =
    expectedSecret && params.webhookSecret && params.webhookSecret.trim() === expectedSecret;
  return tokenOk || secretOk;
}

export function createDailyflowsUnpairRoute(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    const body = await readJson(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: "invalid json" });
      return;
    }

    const accountId =
      typeof body.accountId === "string" && body.accountId.trim()
        ? body.accountId.trim()
        : DEFAULT_ACCOUNT_ID;
    const outboundToken = typeof body.outboundToken === "string" ? body.outboundToken.trim() : "";
    const webhookSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";

    const current = api.runtime.config.loadConfig() as Record<string, unknown>;
    if (!isUnpairAuthorized({ cfg: current, accountId, outboundToken, webhookSecret })) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const next = buildUnpairConfigUpdate({ current, accountId });
    await api.runtime.config.writeConfigFile(next);
    sendJson(res, 200, { ok: true });
  };
}

export { buildUnpairConfigUpdate, isUnpairAuthorized };
