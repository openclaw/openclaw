import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveRequestClientIp,
  withResolvedWebhookRequestPipeline,
} from "openclaw/plugin-sdk/webhook-ingress";
import { normalizeWebhookPath } from "openclaw/plugin-sdk/webhook-path";
import { handleVesicleInbound } from "./inbound.js";
import { normalizeSecretInputString } from "./secret-input.js";
import {
  DEFAULT_WEBHOOK_PATH,
  type ResolvedVesicleAccount,
  type VesicleInboundMessage,
} from "./types.js";

type VesicleRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type VesicleWebhookTarget = {
  account: ResolvedVesicleAccount;
  config: Parameters<typeof handleVesicleInbound>[0]["config"];
  runtime: VesicleRuntimeEnv;
  path: string;
  secret: string;
  statusSink?: (patch: { lastInboundAt?: number }) => void;
};

const webhookTargets = new Map<string, VesicleWebhookTarget[]>();
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});
const webhookInFlightLimiter = createWebhookInFlightLimiter();

export function clearVesicleWebhookSecurityStateForTest(): void {
  webhookRateLimiter.clear();
  webhookInFlightLimiter.clear();
}

export function resolveVesicleWebhookPath(account: ResolvedVesicleAccount): string {
  const raw = account.config.webhookPath?.trim();
  return normalizeWebhookPath(raw || DEFAULT_WEBHOOK_PATH);
}

function normalizeSignature(raw: string | string[] | undefined): string {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!value) {
    return "";
  }
  return value.toLowerCase().startsWith("sha256=") ? value.slice("sha256=".length).trim() : value;
}

export function signVesicleWebhookBody(body: string | Buffer, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyVesicleWebhookSignature(params: {
  body: string;
  secret: string;
  signature: string | string[] | undefined;
}): boolean {
  const supplied = normalizeSignature(params.signature);
  if (!supplied || !params.secret) {
    return false;
  }
  const expected = normalizeSignature(signVesicleWebhookBody(params.body, params.secret));
  return safeEqualSecret(supplied, expected);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseVesicleWebhookPayload(
  rawBody: string,
): { ok: true; message: VesicleInboundMessage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, error: "invalid json" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "invalid payload" };
  }
  const record = parsed as Record<string, unknown>;
  const messageGuid = readString(record.messageGuid);
  const chatGuid = readString(record.chatGuid);
  const sender = readString(record.sender);
  const text = readString(record.text);
  if (!messageGuid || !chatGuid || !sender || !text) {
    return { ok: false, error: "missing required message fields" };
  }
  return {
    ok: true,
    message: {
      messageGuid,
      chatGuid,
      sender,
      text,
      isGroup: typeof record.isGroup === "boolean" ? record.isGroup : undefined,
      service: readString(record.service) || undefined,
      date: readNumber(record.date),
      isFromMe: typeof record.isFromMe === "boolean" ? record.isFromMe : undefined,
      rowId: readNumber(record.rowId) ?? null,
    },
  };
}

function collectTrustedProxies(targets: readonly VesicleWebhookTarget[]): string[] {
  const proxies = new Set<string>();
  for (const target of targets) {
    for (const proxy of target.config.gateway?.trustedProxies ?? []) {
      const normalized = proxy.trim();
      if (normalized) {
        proxies.add(normalized);
      }
    }
  }
  return [...proxies];
}

function resolveWebhookClientIp(
  req: IncomingMessage,
  targets: readonly VesicleWebhookTarget[],
): string {
  const trustedProxies = collectTrustedProxies(targets);
  const allowRealIpFallback = targets.some(
    (target) => target.config.gateway?.allowRealIpFallback === true,
  );
  if (!req.headers["x-forwarded-for"] && !(allowRealIpFallback && req.headers["x-real-ip"])) {
    return req.socket.remoteAddress ?? "unknown";
  }
  return (
    resolveRequestClientIp(req, trustedProxies, allowRealIpFallback) ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

export function registerVesicleWebhookTarget(target: VesicleWebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "vesicle",
      source: "vesicle-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleVesicleWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

export async function handleVesicleWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const normalizedPath = normalizeWebhookPath(requestUrl.pathname);
  const pathTargets = webhookTargets.get(normalizedPath) ?? [];
  const clientIp = resolveWebhookClientIp(req, pathTargets);
  return await withResolvedWebhookRequestPipeline({
    req,
    res,
    targetsByPath: webhookTargets,
    allowMethods: ["POST"],
    requireJsonContentType: true,
    rateLimiter: webhookRateLimiter,
    rateLimitKey: `${normalizedPath}:${clientIp}`,
    inFlightLimiter: webhookInFlightLimiter,
    inFlightKey: `${normalizedPath}:${clientIp}`,
    handle: async ({ targets }) => {
      const body = await readWebhookBodyOrReject({
        req,
        res,
        profile: "pre-auth",
        invalidBodyMessage: "invalid payload",
      });
      if (!body.ok) {
        return true;
      }
      const signature = req.headers["x-vesicle-signature"];
      const target = targets.find((entry) =>
        verifyVesicleWebhookSignature({
          body: body.value,
          secret: entry.secret,
          signature,
        }),
      );
      if (!target) {
        res.statusCode = 401;
        res.end("unauthorized");
        return true;
      }
      const parsed = parseVesicleWebhookPayload(body.value);
      if (!parsed.ok) {
        res.statusCode = 400;
        res.end(parsed.error);
        return true;
      }

      target.statusSink?.({ lastInboundAt: Date.now() });
      handleVesicleInbound({
        account: target.account,
        config: target.config,
        message: parsed.message,
      }).catch((error) => {
        target.runtime.error?.(
          `[${target.account.accountId}] Vesicle webhook failed: ${String(error)}`,
        );
      });

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });
}

export function resolveConfiguredVesicleWebhookSecret(
  account: ResolvedVesicleAccount,
): string | undefined {
  return normalizeSecretInputString(account.config.webhookSecret) ?? undefined;
}
