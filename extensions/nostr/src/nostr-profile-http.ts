/**
 * Nostr Profile HTTP Handler
 *
 * Handles HTTP requests for profile management:
 * - PUT /api/channels/nostr/:accountId/profile - Update and publish profile
 * - POST /api/channels/nostr/:accountId/profile/import - Import from relays
 * - GET /api/channels/nostr/:accountId/profile - Get current profile state
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  readStringValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import {
  readJsonBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { z } from "zod";
import { publishNostrProfile, getNostrProfileState } from "./channel.js";
import { NostrProfileSchema, type NostrProfile } from "./config-schema.js";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";
import {
  normalizeNostrProfileUrlForRuntime,
  validateUrlSafety,
} from "./nostr-profile-url-safety.js";

interface NostrProfileHttpContext {
  /** Get current profile from config */
  getConfigProfile: (accountId: string) => NostrProfile | undefined;
  /** Update profile in config (after successful publish) */
  updateConfigProfile: (accountId: string, profile: NostrProfile) => Promise<void>;
  /** Get account's public key and relays */
  getAccountInfo: (accountId: string) => { pubkey: string; relays: string[] } | null;
  /** Logger */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 requests per minute
const RATE_LIMIT_MAX_TRACKED_KEYS = 2_048;
const profileRateLimiter = createFixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  maxTrackedKeys: RATE_LIMIT_MAX_TRACKED_KEYS,
});

const publishLocks = new KeyedAsyncQueue();

// NIP-05 format: user@domain.com
const nip05FormatSchema = z
  .string()
  .regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid NIP-05 format (user@domain.com)")
  .optional();

// LUD-16 Lightning address format: user@domain.com
const lud16FormatSchema = z
  .string()
  .regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid Lightning address format")
  .optional();

const ProfileUpdateSchema = NostrProfileSchema.extend({
  nip05: nip05FormatSchema,
  lud16: lud16FormatSchema,
});

const PROFILE_MUTATION_SCOPE = "operator.admin";
const PROFILE_URL_FIELDS = ["picture", "banner", "website"] as const;

function normalizeProfileUpdateUrlInputs(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const record = value;
  let normalized: Record<string, unknown> | undefined;
  for (const field of PROFILE_URL_FIELDS) {
    const input = record[field];
    if (typeof input !== "string") {
      continue;
    }
    const next = normalizeNostrProfileUrlForRuntime(input);
    if (next !== input) {
      normalized ??= { ...record };
      normalized[field] = next;
    }
  }
  return normalized ?? value;
}

function restoreProfileUpdateUrlInputs(profile: NostrProfile, value: unknown): NostrProfile {
  if (!isRecord(value)) {
    return profile;
  }
  const record = value;
  return {
    ...profile,
    ...(typeof record.picture === "string" ? { picture: record.picture } : {}),
    ...(typeof record.banner === "string" ? { banner: record.banner } : {}),
    ...(typeof record.website === "string" ? { website: record.website } : {}),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 64 * 1024,
  timeoutMs = 30_000,
): Promise<unknown> {
  const result = await readJsonBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
    emptyObjectOnEmpty: true,
  });
  if (result.ok) {
    return result.value;
  }
  if (result.code === "PAYLOAD_TOO_LARGE") {
    throw new Error("Request body too large");
  }
  if (result.code === "REQUEST_BODY_TIMEOUT" || result.code === "CONNECTION_CLOSED") {
    throw new Error(requestBodyErrorToText(result.code));
  }
  throw new Error(result.code === "INVALID_JSON" ? "Invalid JSON" : result.error);
}

function parseAccountIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/profile/);
  return match?.[1] ?? null;
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) {
    return false;
  }

  const ipLower = normalizeLowercaseStringOrEmpty(remoteAddress).replace(/^\[|\]$/g, "");

  // IPv6 loopback
  if (ipLower === "::1") {
    return true;
  }

  // IPv4 loopback (127.0.0.0/8)
  if (ipLower === "127.0.0.1" || ipLower.startsWith("127.")) {
    return true;
  }

  // IPv4-mapped IPv6
  const v4Mapped = ipLower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    return isLoopbackRemoteAddress(v4Mapped[1]);
  }

  return false;
}

function isLoopbackOriginLike(value: string): boolean {
  try {
    const url = new URL(value);
    return isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return readStringValue(value);
}

function normalizeIpCandidate(raw: string): string {
  const unquoted = raw.trim().replace(/^"|"$/g, "");
  const bracketedWithOptionalPort = unquoted.match(/^\[([^[\]]+)\](?::\d+)?$/);
  if (bracketedWithOptionalPort) {
    return bracketedWithOptionalPort[1] ?? "";
  }
  const ipv4WithPort = unquoted.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (ipv4WithPort) {
    return ipv4WithPort[1] ?? "";
  }
  return unquoted;
}

function hasNonLoopbackForwardedClient(req: IncomingMessage): boolean {
  const forwardedFor = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (forwardedFor) {
    for (const hop of forwardedFor.split(",")) {
      const candidate = normalizeIpCandidate(hop);
      if (!candidate) {
        continue;
      }
      if (!isLoopbackRemoteAddress(candidate)) {
        return true;
      }
    }
  }

  const realIp = firstHeaderValue(req.headers["x-real-ip"]);
  if (realIp) {
    const candidate = normalizeIpCandidate(realIp);
    if (candidate && !isLoopbackRemoteAddress(candidate)) {
      return true;
    }
  }

  return false;
}

function enforceLoopbackMutationGuards(
  ctx: NostrProfileHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  // Mutation endpoints are local-control-plane only.
  const remoteAddress = req.socket.remoteAddress;
  if (!isLoopbackRemoteAddress(remoteAddress)) {
    ctx.log?.warn?.(`Rejected mutation from non-loopback remoteAddress=${String(remoteAddress)}`);
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }

  // If a proxy exposes client-origin headers showing a non-loopback client,
  // treat this as a remote request and deny mutation.
  if (hasNonLoopbackForwardedClient(req)) {
    ctx.log?.warn?.("Rejected mutation with non-loopback forwarded client headers");
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }

  const secFetchSite = normalizeOptionalLowercaseString(
    firstHeaderValue(req.headers["sec-fetch-site"]),
  );
  if (secFetchSite === "cross-site") {
    ctx.log?.warn?.("Rejected mutation with cross-site sec-fetch-site header");
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }

  // CSRF guard: browsers send Origin/Referer on cross-site requests.
  const origin = firstHeaderValue(req.headers.origin);
  if (typeof origin === "string" && !isLoopbackOriginLike(origin)) {
    ctx.log?.warn?.(`Rejected mutation with non-loopback origin=${origin}`);
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }

  const referer = firstHeaderValue(req.headers.referer ?? req.headers.referrer);
  if (typeof referer === "string" && !isLoopbackOriginLike(referer)) {
    ctx.log?.warn?.(`Rejected mutation with non-loopback referer=${referer}`);
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }

  return true;
}

function enforceGatewayMutationScope(
  ctx: NostrProfileHttpContext,
  accountId: string,
  res: ServerResponse,
): boolean {
  const runtimeScopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes;
  const scopes = Array.isArray(runtimeScopes) ? runtimeScopes : [];
  if (scopes.includes(PROFILE_MUTATION_SCOPE)) {
    return true;
  }
  ctx.log?.warn?.(`[${accountId}] Rejected profile mutation missing ${PROFILE_MUTATION_SCOPE}`);
  sendJson(res, 403, { ok: false, error: `missing scope: ${PROFILE_MUTATION_SCOPE}` });
  return false;
}

export function createNostrProfileHttpHandler(
  ctx: NostrProfileHttpContext,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (!url.pathname.startsWith("/api/channels/nostr/")) {
      return false;
    }

    const accountId = parseAccountIdFromPath(url.pathname);
    if (!accountId) {
      return false;
    }

    const isImport = url.pathname.endsWith("/profile/import");
    const isProfilePath = url.pathname.endsWith("/profile") || isImport;

    if (!isProfilePath) {
      return false;
    }

    try {
      if (req.method === "GET" && !isImport) {
        return await handleGetProfile(accountId, ctx, res);
      }

      if ((req.method === "PUT" && !isImport) || (req.method === "POST" && isImport)) {
        if (
          !enforceGatewayMutationScope(ctx, accountId, res) ||
          !enforceLoopbackMutationGuards(ctx, req, res)
        ) {
          return true;
        }
        return await (isImport ? handleImportProfile : handleUpdateProfile)(
          accountId,
          ctx,
          req,
          res,
        );
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    } catch (err) {
      if (res.writableEnded) {
        return true;
      }
      ctx.log?.error(`Profile HTTP error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: "Internal server error" });
      return true;
    }
  };
}

async function handleGetProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  res: ServerResponse,
): Promise<true> {
  const configProfile = ctx.getConfigProfile(accountId);
  const publishState = await getNostrProfileState(accountId);

  sendJson(res, 200, {
    ok: true,
    profile: configProfile ?? null,
    publishState: publishState ?? null,
  });
  return true;
}

async function handleUpdateProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<true> {
  if (profileRateLimiter.isRateLimited(accountId)) {
    sendJson(res, 429, { ok: false, error: "Rate limit exceeded (5 requests/minute)" });
    return true;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }

  const parseResult = ProfileUpdateSchema.safeParse(normalizeProfileUpdateUrlInputs(body));
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    sendJson(res, 400, { ok: false, error: "Validation failed", details: errors });
    return true;
  }

  const profile = restoreProfileUpdateUrlInputs(parseResult.data, body);

  for (const field of PROFILE_URL_FIELDS) {
    const url = profile[field];
    if (!url) {
      continue;
    }
    const check = validateUrlSafety(url);
    if (!check.ok) {
      sendJson(res, 400, { ok: false, error: `${field}: ${check.error}` });
      return true;
    }
  }

  // Merge with existing profile to preserve unknown fields
  const existingProfile = ctx.getConfigProfile(accountId) ?? {};
  const mergedProfile: NostrProfile = {
    ...existingProfile,
    ...profile,
  };

  // Publish with mutex to prevent concurrent publishes
  try {
    const result = await publishLocks.enqueue(accountId, async () => {
      await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
      return await publishNostrProfile(accountId, mergedProfile);
    });

    // Only persist if at least one relay succeeded
    if (result.successes.length > 0) {
      await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
      await ctx.updateConfigProfile(accountId, mergedProfile);
      ctx.log?.info(`[${accountId}] Profile published to ${result.successes.length} relay(s)`);
    } else {
      ctx.log?.warn(`[${accountId}] Profile publish failed on all relays`);
    }

    sendJson(res, 200, {
      ok: true,
      eventId: result.eventId,
      createdAt: result.createdAt,
      successes: result.successes,
      failures: result.failures,
      persisted: result.successes.length > 0,
    });
  } catch (err) {
    if (res.writableEnded) {
      return true;
    }
    ctx.log?.error(`[${accountId}] Profile publish error: ${String(err)}`);
    sendJson(res, 500, { ok: false, error: `Publish failed: ${String(err)}` });
  }

  return true;
}

async function handleImportProfile(
  accountId: string,
  ctx: NostrProfileHttpContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<true> {
  const accountInfo = ctx.getAccountInfo(accountId);
  if (!accountInfo) {
    sendJson(res, 404, { ok: false, error: `Account not found: ${accountId}` });
    return true;
  }

  const { pubkey, relays } = accountInfo;

  if (!pubkey) {
    sendJson(res, 400, { ok: false, error: "Account has no public key configured" });
    return true;
  }

  let autoMerge = false;
  try {
    const body = await readJsonBody(req);
    if (typeof body === "object" && body !== null) {
      autoMerge = (body as { autoMerge?: boolean }).autoMerge === true;
    }
  } catch {
    // Ignore body parse errors - use defaults
  }

  await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
  ctx.log?.info(`[${accountId}] Importing profile for ${pubkey.slice(0, 8)}...`);

  const result = await importProfileFromRelays({
    pubkey,
    relays,
    timeoutMs: 10_000, // 10 seconds for import
  });

  if (!result.ok) {
    sendJson(res, 200, {
      ok: false,
      error: result.error,
      relaysQueried: result.relaysQueried,
    });
    return true;
  }

  let merged: NostrProfile | undefined;
  if (autoMerge && result.profile) {
    await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
    const localProfile = ctx.getConfigProfile(accountId);
    merged = mergeProfiles(localProfile, result.profile);
    await ctx.updateConfigProfile(accountId, merged);
    ctx.log?.info(`[${accountId}] Profile imported and merged`);
  }

  sendJson(res, 200, {
    ok: true,
    imported: result.profile,
    ...(merged ? { merged } : {}),
    saved: merged !== undefined,
    event: result.event,
    sourceRelay: result.sourceRelay,
    relaysQueried: result.relaysQueried,
  });
  return true;
}
