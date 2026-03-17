import {
  createFixedWindowRateLimiter,
  isBlockedHostnameOrIp,
  readJsonBodyWithLimit,
  requestBodyErrorToText
} from "openclaw/plugin-sdk/nostr";
import { z } from "zod";
import { publishNostrProfile, getNostrProfileState } from "./channel.js";
import { NostrProfileSchema } from "./config-schema.js";
import { importProfileFromRelays, mergeProfiles } from "./nostr-profile-import.js";
const RATE_LIMIT_WINDOW_MS = 6e4;
const RATE_LIMIT_MAX_REQUESTS = 5;
const RATE_LIMIT_MAX_TRACKED_KEYS = 2048;
const profileRateLimiter = createFixedWindowRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  maxTrackedKeys: RATE_LIMIT_MAX_TRACKED_KEYS
});
function clearNostrProfileRateLimitStateForTest() {
  profileRateLimiter.clear();
}
function getNostrProfileRateLimitStateSizeForTest() {
  return profileRateLimiter.size();
}
function isNostrProfileRateLimitedForTest(accountId, nowMs) {
  return profileRateLimiter.isRateLimited(accountId, nowMs);
}
function checkRateLimit(accountId) {
  return !profileRateLimiter.isRateLimited(accountId);
}
const publishLocks = /* @__PURE__ */ new Map();
async function withPublishLock(accountId, fn) {
  const prev = publishLocks.get(accountId) ?? Promise.resolve();
  let resolve;
  const next = new Promise((r) => {
    resolve = r;
  });
  publishLocks.set(accountId, next);
  await prev.catch(() => {
  });
  try {
    return await fn();
  } finally {
    resolve();
    if (publishLocks.get(accountId) === next) {
      publishLocks.delete(accountId);
    }
  }
}
function validateUrlSafety(urlStr) {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "https:") {
      return { ok: false, error: "URL must use https:// protocol" };
    }
    const hostname = url.hostname.toLowerCase();
    if (isBlockedHostnameOrIp(hostname)) {
      return { ok: false, error: "URL must not point to private/internal addresses" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Invalid URL format" };
  }
}
const nip05FormatSchema = z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid NIP-05 format (user@domain.com)").optional();
const lud16FormatSchema = z.string().regex(/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "Invalid Lightning address format").optional();
const ProfileUpdateSchema = NostrProfileSchema.extend({
  nip05: nip05FormatSchema,
  lud16: lud16FormatSchema
});
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
async function readJsonBody(req, maxBytes = 64 * 1024, timeoutMs = 3e4) {
  const result = await readJsonBodyWithLimit(req, {
    maxBytes,
    timeoutMs,
    emptyObjectOnEmpty: true
  });
  if (result.ok) {
    return result.value;
  }
  if (result.code === "PAYLOAD_TOO_LARGE") {
    throw new Error("Request body too large");
  }
  if (result.code === "REQUEST_BODY_TIMEOUT") {
    throw new Error(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
  }
  if (result.code === "CONNECTION_CLOSED") {
    throw new Error(requestBodyErrorToText("CONNECTION_CLOSED"));
  }
  throw new Error(result.code === "INVALID_JSON" ? "Invalid JSON" : result.error);
}
function parseAccountIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/channels\/nostr\/([^/]+)\/profile/);
  return match?.[1] ?? null;
}
function isLoopbackRemoteAddress(remoteAddress) {
  if (!remoteAddress) {
    return false;
  }
  const ipLower = remoteAddress.toLowerCase().replace(/^\[|\]$/g, "");
  if (ipLower === "::1") {
    return true;
  }
  if (ipLower === "127.0.0.1" || ipLower.startsWith("127.")) {
    return true;
  }
  const v4Mapped = ipLower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    return isLoopbackRemoteAddress(v4Mapped[1]);
  }
  return false;
}
function isLoopbackOriginLike(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : void 0;
}
function normalizeIpCandidate(raw) {
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
function hasNonLoopbackForwardedClient(req) {
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
function enforceLoopbackMutationGuards(ctx, req, res) {
  const remoteAddress = req.socket.remoteAddress;
  if (!isLoopbackRemoteAddress(remoteAddress)) {
    ctx.log?.warn?.(`Rejected mutation from non-loopback remoteAddress=${String(remoteAddress)}`);
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }
  if (hasNonLoopbackForwardedClient(req)) {
    ctx.log?.warn?.("Rejected mutation with non-loopback forwarded client headers");
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }
  const secFetchSite = firstHeaderValue(req.headers["sec-fetch-site"])?.trim().toLowerCase();
  if (secFetchSite === "cross-site") {
    ctx.log?.warn?.("Rejected mutation with cross-site sec-fetch-site header");
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return false;
  }
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
function createNostrProfileHttpHandler(ctx) {
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
      if (req.method === "PUT" && !isImport) {
        return await handleUpdateProfile(accountId, ctx, req, res);
      }
      if (req.method === "POST" && isImport) {
        return await handleImportProfile(accountId, ctx, req, res);
      }
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    } catch (err) {
      ctx.log?.error(`Profile HTTP error: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: "Internal server error" });
      return true;
    }
  };
}
async function handleGetProfile(accountId, ctx, res) {
  const configProfile = ctx.getConfigProfile(accountId);
  const publishState = await getNostrProfileState(accountId);
  sendJson(res, 200, {
    ok: true,
    profile: configProfile ?? null,
    publishState: publishState ?? null
  });
  return true;
}
async function handleUpdateProfile(accountId, ctx, req, res) {
  if (!enforceLoopbackMutationGuards(ctx, req, res)) {
    return true;
  }
  if (!checkRateLimit(accountId)) {
    sendJson(res, 429, { ok: false, error: "Rate limit exceeded (5 requests/minute)" });
    return true;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: String(err) });
    return true;
  }
  const parseResult = ProfileUpdateSchema.safeParse(body);
  if (!parseResult.success) {
    const errors = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    sendJson(res, 400, { ok: false, error: "Validation failed", details: errors });
    return true;
  }
  const profile = parseResult.data;
  if (profile.picture) {
    const pictureCheck = validateUrlSafety(profile.picture);
    if (!pictureCheck.ok) {
      sendJson(res, 400, { ok: false, error: `picture: ${pictureCheck.error}` });
      return true;
    }
  }
  if (profile.banner) {
    const bannerCheck = validateUrlSafety(profile.banner);
    if (!bannerCheck.ok) {
      sendJson(res, 400, { ok: false, error: `banner: ${bannerCheck.error}` });
      return true;
    }
  }
  if (profile.website) {
    const websiteCheck = validateUrlSafety(profile.website);
    if (!websiteCheck.ok) {
      sendJson(res, 400, { ok: false, error: `website: ${websiteCheck.error}` });
      return true;
    }
  }
  const existingProfile = ctx.getConfigProfile(accountId) ?? {};
  const mergedProfile = {
    ...existingProfile,
    ...profile
  };
  try {
    const result = await withPublishLock(accountId, async () => {
      return await publishNostrProfile(accountId, mergedProfile);
    });
    if (result.successes.length > 0) {
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
      persisted: result.successes.length > 0
    });
  } catch (err) {
    ctx.log?.error(`[${accountId}] Profile publish error: ${String(err)}`);
    sendJson(res, 500, { ok: false, error: `Publish failed: ${String(err)}` });
  }
  return true;
}
async function handleImportProfile(accountId, ctx, req, res) {
  if (!enforceLoopbackMutationGuards(ctx, req, res)) {
    return true;
  }
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
      autoMerge = body.autoMerge === true;
    }
  } catch {
  }
  ctx.log?.info(`[${accountId}] Importing profile for ${pubkey.slice(0, 8)}...`);
  const result = await importProfileFromRelays({
    pubkey,
    relays,
    timeoutMs: 1e4
    // 10 seconds for import
  });
  if (!result.ok) {
    sendJson(res, 200, {
      ok: false,
      error: result.error,
      relaysQueried: result.relaysQueried
    });
    return true;
  }
  if (autoMerge && result.profile) {
    const localProfile = ctx.getConfigProfile(accountId);
    const merged = mergeProfiles(localProfile, result.profile);
    await ctx.updateConfigProfile(accountId, merged);
    ctx.log?.info(`[${accountId}] Profile imported and merged`);
    sendJson(res, 200, {
      ok: true,
      imported: result.profile,
      merged,
      saved: true,
      event: result.event,
      sourceRelay: result.sourceRelay,
      relaysQueried: result.relaysQueried
    });
    return true;
  }
  sendJson(res, 200, {
    ok: true,
    imported: result.profile,
    saved: false,
    event: result.event,
    sourceRelay: result.sourceRelay,
    relaysQueried: result.relaysQueried
  });
  return true;
}
export {
  clearNostrProfileRateLimitStateForTest,
  createNostrProfileHttpHandler,
  getNostrProfileRateLimitStateSizeForTest,
  isNostrProfileRateLimitedForTest,
  validateUrlSafety
};
