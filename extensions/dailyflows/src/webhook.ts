import type { IncomingMessage, ServerResponse } from "node:http";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  resolveDailyflowsWebhookPath,
  resolveDailyflowsWebhookSecret,
} from "./config.js";
import { handleDailyflowsInbound } from "./inbound.js";
import { isDailyflowsSignatureValid } from "./signature.js";
import type { DailyflowsWebhookPayload } from "./types.js";

const MAX_SKEW_MS = 5 * 60 * 1000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function parseJson(body: string): DailyflowsWebhookPayload | null {
  try {
    const parsed = JSON.parse(body) as DailyflowsWebhookPayload;
    if (!parsed?.id || !parsed?.type || !parsed?.message) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createDailyflowsWebhookHandler(api: OpenClawPluginApi) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cfg = api.runtime.config.loadConfig();
    const expectedPath = resolveDailyflowsWebhookPath(cfg);
    if (url.pathname !== expectedPath) {
      return false;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return true;
    }

    const timestamp = String(req.headers["x-dailyflows-timestamp"] ?? "").trim();
    const signature = String(req.headers["x-dailyflows-signature"] ?? "").trim();
    const eventType = String(req.headers["x-dailyflows-event"] ?? "").trim();

    if (!timestamp || !signature) {
      res.statusCode = 400;
      res.end("missing signature headers");
      return true;
    }

    const parsedTimestamp = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(parsedTimestamp)) {
      res.statusCode = 400;
      res.end("invalid timestamp");
      return true;
    }
    if (Math.abs(Date.now() - parsedTimestamp) > MAX_SKEW_MS) {
      res.statusCode = 401;
      res.end("stale timestamp");
      return true;
    }

    const body = await readBody(req);
    const payload = parseJson(body);
    if (!payload) {
      res.statusCode = 400;
      res.end("invalid payload");
      return true;
    }
    if (eventType && eventType !== payload.type) {
      res.statusCode = 400;
      res.end("event mismatch");
      return true;
    }

    const secret = resolveDailyflowsWebhookSecret({
      cfg,
      accountId: payload.accountId,
    });
    if (!secret) {
      res.statusCode = 401;
      res.end("webhook secret not configured");
      return true;
    }
    if (!isDailyflowsSignatureValid({ secret, timestamp, signature, body })) {
      res.statusCode = 401;
      res.end("invalid signature");
      return true;
    }

    res.statusCode = 200;
    res.end("ok");

    try {
      await handleDailyflowsInbound({
        payload,
        cfg,
        runtime: { error: (msg) => api.logger.error(msg) },
      });
    } catch (err) {
      api.logger.error(`dailyflows webhook handler failed: ${String(err)}`);
    }
    return true;
  };
}
