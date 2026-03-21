import type { IncomingMessage, ServerResponse } from "node:http";
import {
  readJsonWebhookBodyOrReject,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import type { CampfireWebhookPayload } from "../types.js";
import { parseCampfirePayload } from "./payload.js";

type CampfireWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type CampfireInboundHandler = (payload: CampfireWebhookPayload) => Promise<void> | void;

function resolveRequestSecret(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("secret");
  } catch {
    return null;
  }
}

export function createCampfireWebhookHandler(params: {
  webhookSecret?: string;
  onInbound: CampfireInboundHandler;
  log?: CampfireWebhookLog;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    if (params.webhookSecret) {
      const secret = resolveRequestSecret(req);
      if (secret !== params.webhookSecret) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    const parsedBody = await readJsonWebhookBodyOrReject({
      req,
      res,
      profile: "pre-auth",
      invalidJsonMessage: "Bad Request",
    });
    if (!parsedBody.ok) {
      return;
    }

    const payload = parseCampfirePayload(parsedBody.value);
    if (!payload) {
      res.statusCode = 400;
      res.end("Bad Request");
      return;
    }

    res.statusCode = 200;
    res.end("OK");

    setImmediate(() => {
      void Promise.resolve(params.onInbound(payload)).catch((err) => {
        params.log?.error?.(`Campfire inbound dispatch failed: ${String(err)}`);
      });
    });
  };
}

export function registerCampfireWebhookRoute(params: {
  accountId: string;
  path?: string;
  webhookSecret?: string;
  onInbound: CampfireInboundHandler;
  log?: CampfireWebhookLog;
}): () => void {
  return registerPluginHttpRoute({
    path: params.path ?? `/channels/campfire/webhook/${params.accountId}`,
    auth: "plugin",
    match: "exact",
    replaceExisting: true,
    pluginId: "campfire",
    accountId: params.accountId,
    source: "campfire-webhook",
    log: (message) => params.log?.info?.(message),
    handler: createCampfireWebhookHandler({
      webhookSecret: params.webhookSecret,
      onInbound: params.onInbound,
      log: params.log,
    }),
  });
}
