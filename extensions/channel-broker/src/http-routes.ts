import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  buildBrokerInboundDedupeKey,
  normalizeBrokerInboundEvent,
  type BrokerInboundEventV1,
} from "openclaw/plugin-sdk/channel-broker";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { readWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-request-guards";
import { isListedChannelBrokerProviderId, resolveChannelBrokerAccount } from "./accounts.js";
import { receiveBrokerInboundEvent } from "./runtime.js";
import type { CoreConfig, ResolvedChannelBrokerAccount } from "./types.js";

const INBOUND_PATH = "/api/v1/channel-broker/inbound";
const SIGNATURE_HEADER = "x-openclaw-broker-signature";

function sendJson(res: ServerResponse, statusCode: number, body: Record<string, unknown>): true {
  res.statusCode = statusCode;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeSignature(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.startsWith("sha256=") ? trimmed.slice("sha256=".length) : trimmed;
}

function verifySignature(params: { body: string; secret: string; signature: string }): boolean {
  const expected = createHmac("sha256", params.secret).update(params.body).digest("hex");
  const actual = normalizeSignature(params.signature);
  if (!actual || actual.length !== expected.length || !/^[a-f0-9]+$/iu.test(actual)) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isSenderAllowed(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): boolean {
  const allowed = params.account.allowFrom.map((value) => String(value).trim()).filter(Boolean);
  if (allowed.includes("*")) {
    return true;
  }
  if (allowed.length === 0) {
    return false;
  }
  const candidates = new Set([
    params.event.sender.id,
    params.event.sender.handle ?? "",
    `${params.event.platform}:${params.event.sender.id}`,
    params.event.message.nativeIds?.from ?? "",
  ]);
  return allowed.some((entry) => candidates.has(entry));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeInboundEventForAccount(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): { ok: true; event: BrokerInboundEventV1 } | { ok: false; error: string; statusCode: number } {
  const platform = params.account.platformAliases[params.event.platform] ?? params.event.platform;
  if (params.account.platforms.length > 0 && !params.account.platforms.includes(platform)) {
    return { ok: false, statusCode: 403, error: "unsupported_platform" };
  }
  const configuredAccountId = normalizeOptionalString(params.account.config.accountId);
  if (configuredAccountId && params.event.accountId !== configuredAccountId) {
    return { ok: false, statusCode: 403, error: "account_id_mismatch" };
  }
  if (platform === params.event.platform) {
    return { ok: true, event: params.event };
  }
  return {
    ok: true,
    event: {
      ...params.event,
      platform,
    },
  };
}

function parseInboundEvent(value: unknown): BrokerInboundEventV1 {
  return normalizeBrokerInboundEvent(value as BrokerInboundEventV1);
}

export async function handleChannelBrokerInboundHttpRequest(params: {
  cfg: CoreConfig;
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<boolean> {
  if (params.req.method !== "POST") {
    return sendJson(params.res, 405, { ok: false, error: "method_not_allowed" });
  }

  const body = await readWebhookBodyOrReject({
    req: params.req,
    res: params.res,
    profile: "pre-auth",
    invalidBodyMessage: "invalid payload",
  });
  if (!body.ok) {
    return true;
  }

  let event: BrokerInboundEventV1;
  try {
    event = parseInboundEvent(JSON.parse(body.value));
  } catch (error) {
    return sendJson(params.res, 400, {
      ok: false,
      error: "invalid_event",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  if (!isListedChannelBrokerProviderId(params.cfg, event.providerId)) {
    return sendJson(params.res, 404, { ok: false, error: "provider_not_configured" });
  }
  const account = resolveChannelBrokerAccount({ cfg: params.cfg, accountId: event.providerId });
  if (!account.enabled || !account.configured) {
    return sendJson(params.res, 404, { ok: false, error: "provider_not_configured" });
  }
  if (!account.signingSecret) {
    return sendJson(params.res, 401, { ok: false, error: "missing_signing_secret" });
  }
  if (
    !verifySignature({
      body: body.value,
      secret: account.signingSecret,
      signature: getHeader(params.req, SIGNATURE_HEADER) ?? "",
    })
  ) {
    return sendJson(params.res, 401, { ok: false, error: "invalid_signature" });
  }
  const accountScopedEvent = normalizeInboundEventForAccount({ account, event });
  if (!accountScopedEvent.ok) {
    return sendJson(params.res, accountScopedEvent.statusCode, {
      ok: false,
      error: accountScopedEvent.error,
    });
  }
  event = accountScopedEvent.event;
  if (!isSenderAllowed({ account, event })) {
    return sendJson(params.res, 403, { ok: false, error: "sender_not_allowed" });
  }

  const dedupeKey = buildBrokerInboundDedupeKey(event);
  const result = await receiveBrokerInboundEvent({
    account,
    event,
    dedupeKey,
    ackPolicy: "after_durable_send",
  });
  return sendJson(params.res, result.status === "accepted" ? 202 : 200, {
    ok: result.status !== "rejected",
    status: result.status,
    dedupeKey,
    ...(result.message ? { message: result.message } : {}),
  });
}

export function registerChannelBrokerHttpRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: INBOUND_PATH,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) =>
      await handleChannelBrokerInboundHttpRequest({ cfg: api.config as CoreConfig, req, res }),
  });
}
