import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import {
  buildBrokerInboundDedupeKey,
  normalizeBrokerPlatformId,
  normalizeBrokerInboundEvent,
  type BrokerInboundEventV1,
} from "openclaw/plugin-sdk/channel-broker";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { isListedChannelBrokerProviderId, resolveChannelBrokerAccount } from "./accounts.js";
import { normalizeKnownChannelBrokerPlatformId } from "./platforms.js";
import { receiveBrokerInboundEvent } from "./runtime.js";
import type { CoreConfig, ResolvedChannelBrokerAccount } from "./types.js";

const INBOUND_PATH = "/channel-broker/inbound";
const PROVIDER_HEADER = "x-openclaw-broker-provider";
const SIGNATURE_HEADER = "x-openclaw-broker-signature";
const TIMESTAMP_HEADER = "x-openclaw-broker-timestamp";
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
const TRUSTED_PROVIDER_BODY_MAX_BYTES = WEBHOOK_BODY_READ_DEFAULTS.postAuth.maxBytes;
const channelBrokerInboundInFlightLimiter = createWebhookInFlightLimiter();

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

function parseSignatureTimestamp(value: string | undefined, now = Date.now()): number | null {
  const timestamp = Number(value?.trim());
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.abs(now - timestamp) <= SIGNATURE_MAX_AGE_MS ? timestamp : null;
}

function verifySignature(params: {
  body: string;
  secret: string;
  signature: string;
  timestamp: number;
}): boolean {
  const expected = createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.body}`)
    .digest("hex");
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

function normalizePlatformQualifiedAllowFrom(
  entry: string,
  account: ResolvedChannelBrokerAccount,
): string {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    return entry;
  }
  try {
    const rawPlatform = normalizeBrokerPlatformId(entry.slice(0, separatorIndex));
    const platform =
      account.platformAliases[rawPlatform] ?? normalizeKnownChannelBrokerPlatformId(rawPlatform);
    return `${platform}:${entry.slice(separatorIndex + 1)}`;
  } catch {
    return entry;
  }
}

function isSenderAllowed(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): boolean {
  const allowed = params.account.allowFrom.map((value) => String(value).trim()).filter(Boolean);
  if (allowed.some((entry) => parseAccessGroupAllowFromEntry(entry) !== null)) {
    return true;
  }
  if (allowed.includes("*")) {
    return true;
  }
  if (allowed.length === 0) {
    return false;
  }
  const normalizedAllowed = new Set([
    ...allowed,
    ...allowed.map((entry) => normalizePlatformQualifiedAllowFrom(entry, params.account)),
  ]);
  const candidates = new Set([
    params.event.sender.id,
    `${params.event.platform}:${params.event.sender.id}`,
    params.event.message.nativeIds?.from ?? "",
  ]);
  return [...normalizedAllowed].some((entry) => candidates.has(entry));
}

function isSelfOriginatedEvent(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): boolean {
  const nativeAccountId =
    normalizeOptionalString(params.event.accountId) ?? params.account.accountId;
  return params.event.sender.id === nativeAccountId;
}

function hasExplicitSenderAllowance(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): boolean {
  const allowed = params.account.allowFrom.map((value) => String(value).trim()).filter(Boolean);
  if (allowed.some((entry) => parseAccessGroupAllowFromEntry(entry) !== null)) {
    return true;
  }
  const normalizedAllowed = new Set([
    ...allowed.filter((entry) => entry !== "*"),
    ...allowed
      .filter((entry) => entry !== "*")
      .map((entry) => normalizePlatformQualifiedAllowFrom(entry, params.account)),
  ]);
  const candidates = new Set([
    params.event.sender.id,
    params.event.sender.handle ?? "",
    `${params.event.platform}:${params.event.sender.id}`,
    params.event.message.nativeIds?.from ?? "",
  ]);
  return [...normalizedAllowed].some((entry) => candidates.has(entry));
}

function isWildcardOnlyBotSender(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): boolean {
  return params.event.sender.isBot === true && !hasExplicitSenderAllowance(params);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getInboundInFlightKey(req: IncomingMessage): string {
  return `channel-broker:${req.socket?.remoteAddress ?? "unknown"}`;
}

function extractInboundProviderId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const providerId = (value as { providerId?: unknown }).providerId;
  return typeof providerId === "string" ? normalizeOptionalString(providerId) : undefined;
}

function normalizeInboundEventForAccount(params: {
  account: ResolvedChannelBrokerAccount;
  event: BrokerInboundEventV1;
}): { ok: true; event: BrokerInboundEventV1 } | { ok: false; error: string; statusCode: number } {
  const platform =
    params.account.platformAliases[params.event.platform] ??
    normalizeKnownChannelBrokerPlatformId(params.event.platform);
  if (params.account.platforms.length > 0 && !params.account.platforms.includes(platform)) {
    return { ok: false, statusCode: 403, error: "unsupported_platform" };
  }
  const configuredAccountId = normalizeOptionalString(params.account.config.accountId);
  if (configuredAccountId && params.event.accountId !== configuredAccountId) {
    return { ok: false, statusCode: 403, error: "account_id_mismatch" };
  }
  if (platform === params.event.platform && params.account.providerId === params.event.providerId) {
    return { ok: true, event: params.event };
  }
  return {
    ok: true,
    event: {
      ...params.event,
      providerId: params.account.providerId,
      platform,
    },
  };
}

function parseInboundEvent(value: unknown): BrokerInboundEventV1 {
  return normalizeBrokerInboundEvent(value as BrokerInboundEventV1);
}

function inboundReceiveStatusCode(result: Awaited<ReturnType<typeof receiveBrokerInboundEvent>>) {
  switch (result.status) {
    case "accepted":
      return 202;
    case "pending":
      return 425;
    case "duplicate":
      return 200;
    case "rejected":
      return result.message === "delivery_failed" ? 425 : 200;
  }
  const unreachableStatus: never = result.status;
  return unreachableStatus;
}

export async function handleChannelBrokerInboundHttpRequest(params: {
  cfg: CoreConfig;
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<boolean> {
  if (params.req.method !== "POST") {
    return sendJson(params.res, 405, { ok: false, error: "method_not_allowed" });
  }

  const requestLifecycle = beginWebhookRequestPipelineOrReject({
    req: params.req,
    res: params.res,
    inFlightLimiter: channelBrokerInboundInFlightLimiter,
    inFlightKey: getInboundInFlightKey(params.req),
  });
  if (!requestLifecycle.ok) {
    return true;
  }
  let requestLifecycleReleased = false;
  const releaseRequestLifecycle = () => {
    if (!requestLifecycleReleased) {
      requestLifecycle.release();
      requestLifecycleReleased = true;
    }
  };

  try {
    const providerIdHint = normalizeOptionalString(getHeader(params.req, PROVIDER_HEADER));
    if (providerIdHint && !isListedChannelBrokerProviderId(params.cfg, providerIdHint)) {
      return sendJson(params.res, 404, { ok: false, error: "provider_not_configured" });
    }

    const body = await readWebhookBodyOrReject({
      req: params.req,
      res: params.res,
      profile: "pre-auth",
      maxBytes: providerIdHint ? TRUSTED_PROVIDER_BODY_MAX_BYTES : undefined,
      invalidBodyMessage: "invalid payload",
    });
    if (!body.ok) {
      return true;
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body.value);
    } catch (error) {
      return sendJson(params.res, 400, {
        ok: false,
        error: "invalid_event",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const bodyProviderId = extractInboundProviderId(parsedBody);
    if (providerIdHint && bodyProviderId && bodyProviderId !== providerIdHint) {
      return sendJson(params.res, 400, {
        ok: false,
        error: "provider_id_mismatch",
      });
    }

    const providerId = providerIdHint ?? bodyProviderId;
    if (!providerId) {
      return sendJson(params.res, 400, {
        ok: false,
        error: "invalid_event",
        message: "missing broker provider id",
      });
    }

    if (!isListedChannelBrokerProviderId(params.cfg, providerId)) {
      return sendJson(params.res, 404, { ok: false, error: "provider_not_configured" });
    }
    const account = resolveChannelBrokerAccount({ cfg: params.cfg, accountId: providerId });
    if (!account.enabled || !account.configured) {
      return sendJson(params.res, 404, { ok: false, error: "provider_not_configured" });
    }
    if (!account.signingSecret) {
      return sendJson(params.res, 401, { ok: false, error: "missing_signing_secret" });
    }
    const signatureTimestamp = parseSignatureTimestamp(getHeader(params.req, TIMESTAMP_HEADER));
    if (signatureTimestamp === null) {
      return sendJson(params.res, 401, { ok: false, error: "invalid_signature_timestamp" });
    }
    if (
      !verifySignature({
        body: body.value,
        secret: account.signingSecret,
        signature: getHeader(params.req, SIGNATURE_HEADER) ?? "",
        timestamp: signatureTimestamp,
      })
    ) {
      return sendJson(params.res, 401, { ok: false, error: "invalid_signature" });
    }
    releaseRequestLifecycle();

    let event: BrokerInboundEventV1;
    try {
      event = parseInboundEvent(parsedBody);
    } catch (error) {
      return sendJson(params.res, 400, {
        ok: false,
        error: "invalid_event",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const accountScopedEvent = normalizeInboundEventForAccount({ account, event });
    if (!accountScopedEvent.ok) {
      return sendJson(params.res, accountScopedEvent.statusCode, {
        ok: false,
        error: accountScopedEvent.error,
      });
    }
    event = accountScopedEvent.event;
    if (isSelfOriginatedEvent({ account, event })) {
      return sendJson(params.res, 200, { ok: true, status: "ignored", reason: "self_sender" });
    }
    if (isWildcardOnlyBotSender({ account, event })) {
      return sendJson(params.res, 200, { ok: true, status: "ignored", reason: "bot_sender" });
    }
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
    return sendJson(params.res, inboundReceiveStatusCode(result), {
      ok: result.status === "accepted" || result.status === "duplicate",
      status: result.status,
      dedupeKey,
      ...(result.message ? { message: result.message } : {}),
    });
  } finally {
    releaseRequestLifecycle();
  }
}

export function registerChannelBrokerHttpRoutes(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: INBOUND_PATH,
    auth: "plugin",
    match: "exact",
    handler: async (req, res) =>
      await handleChannelBrokerInboundHttpRequest({
        cfg: api.runtime.config.current() as CoreConfig,
        req,
        res,
      }),
  });
}
