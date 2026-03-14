import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyTwilioWebhook, type WebhookContext } from "openclaw/plugin-sdk/twilio-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/twilio-sms";
import {
  normalizeWebhookPath,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
} from "openclaw/plugin-sdk/twilio-sms";
import { processTwilioSmsMessage } from "./monitor-processing.js";
import { getTwilioSmsRuntime } from "./runtime.js";
import type { ResolvedTwilioSmsAccount } from "./types.js";

export type TwilioSmsRuntimeEnv = {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type TwilioSmsCoreRuntime = ReturnType<typeof getTwilioSmsRuntime>;

export type WebhookTarget = {
  account: ResolvedTwilioSmsAccount;
  config: OpenClawConfig;
  runtime: TwilioSmsRuntimeEnv;
  core: TwilioSmsCoreRuntime;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const DEFAULT_WEBHOOK_PATH = "/twilio-sms/webhook";
const webhookTargets = new Map<string, WebhookTarget[]>();

export function resolveWebhookPathFromConfig(config: { webhookPath?: string } | undefined): string {
  return normalizeWebhookPath(config?.webhookPath ?? DEFAULT_WEBHOOK_PATH);
}

export function registerTwilioSmsWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      // Twilio provides its own signature-based auth; the plugin validates it.
      auth: "plugin",
      match: "exact",
      pluginId: "twilio-sms",
      source: "twilio-sms-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        await handleTwilioSmsWebhookRequest(req, res);
      },
    },
  }).unregister;
}

async function handleTwilioSmsWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Read the raw POST body (URL-encoded form data from Twilio)
  const bodyResult = await readWebhookBodyOrReject({
    req,
    res,
    maxBytes: 64 * 1024,
    invalidBodyMessage: "Invalid Twilio SMS webhook body",
  });
  if (!bodyResult.ok) {
    return;
  }
  const rawBody = bodyResult.value;

  // Resolve the webhook target
  const path = normalizeWebhookPath(req.url ?? "");
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return;
  }
  const target = targets[0];

  // Build webhook context for signature verification
  const ctx: WebhookContext = {
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody,
    url: req.url ?? "/",
    method: (req.method ?? "POST") as WebhookContext["method"],
    remoteAddress: req.socket.remoteAddress,
  };

  // Validate Twilio signature (fail-closed: reject when authToken is missing
  // unless signature validation is explicitly disabled).
  const authToken = target.account.config.authToken;
  if (!target.account.config.skipSignatureValidation) {
    if (!authToken) {
      target.runtime.error?.(
        "[twilio-sms] Webhook rejected: authToken not configured (signature verification requires it)",
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return;
    }
    const verification = verifyTwilioWebhook(ctx, authToken, {
      publicUrl: target.account.config.webhookUrl,
      skipVerification: false,
      trustForwardingHeaders: true,
    });
    if (!verification.ok) {
      target.runtime.error?.(
        `[twilio-sms] Webhook signature verification failed: ${verification.reason}`,
      );
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return;
    }
    if (verification.isReplay) {
      // Already processed this request — return 200 without re-processing.
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/xml; charset=utf-8");
      res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
      return;
    }
  }

  // Return 200 immediately with empty TwiML — agent processing is async.
  // This prevents Twilio from retrying due to its ~15s webhook timeout.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/xml; charset=utf-8");
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Parse the webhook payload
  const urlParams = new URLSearchParams(rawBody);
  const from = urlParams.get("From") ?? "";
  const to = urlParams.get("To") ?? "";
  const body = urlParams.get("Body") ?? "";
  const messageSid = urlParams.get("MessageSid") ?? "";
  const numMedia = parseInt(urlParams.get("NumMedia") ?? "0", 10);

  const mediaUrls: Array<{ url: string; contentType: string }> = [];
  for (let i = 0; i < numMedia; i++) {
    const url = urlParams.get(`MediaUrl${i}`);
    const ct = urlParams.get(`MediaContentType${i}`) ?? "application/octet-stream";
    if (url) {
      mediaUrls.push({ url, contentType: ct });
    }
  }

  if (!from || !messageSid) {
    target.runtime.error?.("[twilio-sms] Webhook missing From or MessageSid");
    return;
  }

  target.statusSink?.({ lastInboundAt: Date.now() });

  // Process asynchronously — errors are logged, not propagated to Twilio.
  void processTwilioSmsMessage({
    payload: { messageSid, from, to, body, numMedia, mediaUrls },
    target,
  }).catch((err) => {
    target.runtime.error?.(`[twilio-sms] Error processing message: ${String(err)}`);
  });
}
