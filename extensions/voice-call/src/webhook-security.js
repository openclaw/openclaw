import crypto from "node:crypto";
import { getHeader } from "./http-headers.js";
const REPLAY_WINDOW_MS = 10 * 60 * 1e3;
const REPLAY_CACHE_MAX_ENTRIES = 1e4;
const REPLAY_CACHE_PRUNE_INTERVAL = 64;
const twilioReplayCache = {
  seenUntil: /* @__PURE__ */ new Map(),
  calls: 0
};
const plivoReplayCache = {
  seenUntil: /* @__PURE__ */ new Map(),
  calls: 0
};
const telnyxReplayCache = {
  seenUntil: /* @__PURE__ */ new Map(),
  calls: 0
};
function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}
function createSkippedVerificationReplayKey(provider, ctx) {
  return `${provider}:skip:${sha256Hex(`${ctx.method}
${ctx.url}
${ctx.rawBody}`)}`;
}
function pruneReplayCache(cache, now) {
  for (const [key, expiresAt] of cache.seenUntil) {
    if (expiresAt <= now) {
      cache.seenUntil.delete(key);
    }
  }
  while (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    const oldest = cache.seenUntil.keys().next().value;
    if (!oldest) {
      break;
    }
    cache.seenUntil.delete(oldest);
  }
}
function markReplay(cache, replayKey) {
  const now = Date.now();
  cache.calls += 1;
  if (cache.calls % REPLAY_CACHE_PRUNE_INTERVAL === 0) {
    pruneReplayCache(cache, now);
  }
  const existing = cache.seenUntil.get(replayKey);
  if (existing && existing > now) {
    return true;
  }
  cache.seenUntil.set(replayKey, now + REPLAY_WINDOW_MS);
  if (cache.seenUntil.size > REPLAY_CACHE_MAX_ENTRIES) {
    pruneReplayCache(cache, now);
  }
  return false;
}
function validateTwilioSignature(authToken, signature, url, params) {
  if (!signature) {
    return false;
  }
  const dataToSign = buildTwilioDataToSign(url, params);
  const expectedSignature = crypto.createHmac("sha1", authToken).update(dataToSign).digest("base64");
  return timingSafeEqual(signature, expectedSignature);
}
function buildTwilioDataToSign(url, params) {
  let dataToSign = url;
  const sortedParams = Array.from(params.entries()).toSorted(
    (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  );
  for (const [key, value] of sortedParams) {
    dataToSign += key + value;
  }
  return dataToSign;
}
function buildCanonicalTwilioParamString(params) {
  return Array.from(params.entries()).toSorted((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}
function isValidHostname(hostname) {
  if (!hostname || hostname.length > 253) {
    return false;
  }
  const hostnameRegex = /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  return hostnameRegex.test(hostname);
}
function extractHostname(hostHeader) {
  if (!hostHeader) {
    return null;
  }
  let hostname;
  if (hostHeader.startsWith("[")) {
    const endBracket = hostHeader.indexOf("]");
    if (endBracket === -1) {
      return null;
    }
    hostname = hostHeader.substring(1, endBracket);
    return hostname.toLowerCase();
  }
  if (hostHeader.includes("@")) {
    return null;
  }
  hostname = hostHeader.split(":")[0];
  if (!isValidHostname(hostname)) {
    return null;
  }
  return hostname.toLowerCase();
}
function extractHostnameFromHeader(headerValue) {
  const first = headerValue.split(",")[0]?.trim();
  if (!first) {
    return null;
  }
  return extractHostname(first);
}
function normalizeAllowedHosts(allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) {
    return null;
  }
  const normalized = /* @__PURE__ */ new Set();
  for (const host of allowedHosts) {
    const extracted = extractHostname(host.trim());
    if (extracted) {
      normalized.add(extracted);
    }
  }
  return normalized.size > 0 ? normalized : null;
}
function reconstructWebhookUrl(ctx, options) {
  const { headers } = ctx;
  const allowedHosts = normalizeAllowedHosts(options?.allowedHosts);
  const hasAllowedHosts = allowedHosts !== null;
  const explicitlyTrusted = options?.trustForwardingHeaders === true;
  const trustedProxyIPs = options?.trustedProxyIPs?.filter(Boolean) ?? [];
  const hasTrustedProxyIPs = trustedProxyIPs.length > 0;
  const remoteIP = options?.remoteIP ?? ctx.remoteAddress;
  const fromTrustedProxy = !hasTrustedProxyIPs || (remoteIP ? trustedProxyIPs.includes(remoteIP) : false);
  const shouldTrustForwardingHeaders = (hasAllowedHosts || explicitlyTrusted) && fromTrustedProxy;
  const isAllowedForwardedHost = (host2) => !allowedHosts || allowedHosts.has(host2);
  let proto = "https";
  if (shouldTrustForwardingHeaders) {
    const forwardedProto = getHeader(headers, "x-forwarded-proto");
    if (forwardedProto === "http" || forwardedProto === "https") {
      proto = forwardedProto;
    }
  }
  let host = null;
  if (shouldTrustForwardingHeaders) {
    const forwardingHeaders = ["x-forwarded-host", "x-original-host", "ngrok-forwarded-host"];
    for (const headerName of forwardingHeaders) {
      const headerValue = getHeader(headers, headerName);
      if (headerValue) {
        const extracted = extractHostnameFromHeader(headerValue);
        if (extracted && isAllowedForwardedHost(extracted)) {
          host = extracted;
          break;
        }
      }
    }
  }
  if (!host) {
    const hostHeader = getHeader(headers, "host");
    if (hostHeader) {
      const extracted = extractHostnameFromHeader(hostHeader);
      if (extracted) {
        host = extracted;
      }
    }
  }
  if (!host) {
    try {
      const parsed = new URL(ctx.url);
      const extracted = extractHostname(parsed.host);
      if (extracted) {
        host = extracted;
      }
    } catch {
      host = "";
    }
  }
  if (!host) {
    host = "";
  }
  let path = "/";
  try {
    const parsed = new URL(ctx.url);
    path = parsed.pathname + parsed.search;
  } catch {
  }
  return `${proto}://${host}${path}`;
}
function buildTwilioVerificationUrl(ctx, publicUrl, urlOptions) {
  if (!publicUrl) {
    return reconstructWebhookUrl(ctx, urlOptions);
  }
  try {
    const base = new URL(publicUrl);
    const requestUrl = new URL(ctx.url);
    base.pathname = requestUrl.pathname;
    base.search = requestUrl.search;
    return base.toString();
  } catch {
    return publicUrl;
  }
}
function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }
  if (address === "127.0.0.1" || address === "::1") {
    return true;
  }
  if (address.startsWith("::ffff:127.")) {
    return true;
  }
  return false;
}
function stripPortFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.port) {
      return url;
    }
    parsed.port = "";
    return parsed.toString();
  } catch {
    return url;
  }
}
function setPortOnUrl(url, port) {
  try {
    const parsed = new URL(url);
    parsed.port = port;
    return parsed.toString();
  } catch {
    return url;
  }
}
function extractPortFromHostHeader(hostHeader) {
  if (!hostHeader) {
    return void 0;
  }
  try {
    const parsed = new URL(`https://${hostHeader}`);
    return parsed.port || void 0;
  } catch {
    return void 0;
  }
}
function createTwilioReplayKey(params) {
  const canonicalParams = buildCanonicalTwilioParamString(params.requestParams);
  return `twilio:req:${sha256Hex(
    `${params.verificationUrl}
${canonicalParams}
${params.signature}`
  )}`;
}
function decodeBase64OrBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - normalized.length % 4) % 4;
  const padded = normalized + "=".repeat(padLen);
  return Buffer.from(padded, "base64");
}
function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function importEd25519PublicKey(publicKey) {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith("-----BEGIN")) {
    return trimmed;
  }
  const decoded = decodeBase64OrBase64Url(trimmed);
  if (decoded.length === 32) {
    return crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: base64UrlEncode(decoded) },
      format: "jwk"
    });
  }
  return crypto.createPublicKey({
    key: decoded,
    format: "der",
    type: "spki"
  });
}
function verifyTelnyxWebhook(ctx, publicKey, options) {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("telnyx", ctx);
    const isReplay = markReplay(telnyxReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey
    };
  }
  if (!publicKey) {
    return { ok: false, reason: "Missing telnyx.publicKey (configure to verify webhooks)" };
  }
  const signature = getHeader(ctx.headers, "telnyx-signature-ed25519");
  const timestamp = getHeader(ctx.headers, "telnyx-timestamp");
  if (!signature || !timestamp) {
    return { ok: false, reason: "Missing signature or timestamp header" };
  }
  const eventTimeSec = parseInt(timestamp, 10);
  if (!Number.isFinite(eventTimeSec)) {
    return { ok: false, reason: "Invalid timestamp header" };
  }
  try {
    const signedPayload = `${timestamp}|${ctx.rawBody}`;
    const signatureBuffer = decodeBase64OrBase64Url(signature);
    const key = importEd25519PublicKey(publicKey);
    const isValid = crypto.verify(null, Buffer.from(signedPayload), key, signatureBuffer);
    if (!isValid) {
      return { ok: false, reason: "Invalid signature" };
    }
    const maxSkewMs = options?.maxSkewMs ?? 5 * 60 * 1e3;
    const eventTimeMs = eventTimeSec * 1e3;
    const now = Date.now();
    if (Math.abs(now - eventTimeMs) > maxSkewMs) {
      return { ok: false, reason: "Timestamp too old" };
    }
    const replayKey = `telnyx:${sha256Hex(`${timestamp}
${signature}
${ctx.rawBody}`)}`;
    const isReplay = markReplay(telnyxReplayCache, replayKey);
    return { ok: true, isReplay, verifiedRequestKey: replayKey };
  } catch (err) {
    return {
      ok: false,
      reason: `Verification error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
function verifyTwilioWebhook(ctx, authToken, options) {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("twilio", ctx);
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey
    };
  }
  const signature = getHeader(ctx.headers, "x-twilio-signature");
  if (!signature) {
    return { ok: false, reason: "Missing X-Twilio-Signature header" };
  }
  const isLoopback = isLoopbackAddress(options?.remoteIP ?? ctx.remoteAddress);
  const allowLoopbackForwarding = options?.allowNgrokFreeTierLoopbackBypass && isLoopback;
  const verificationUrl = buildTwilioVerificationUrl(ctx, options?.publicUrl, {
    allowedHosts: options?.allowedHosts,
    trustForwardingHeaders: options?.trustForwardingHeaders || allowLoopbackForwarding,
    trustedProxyIPs: options?.trustedProxyIPs,
    remoteIP: options?.remoteIP
  });
  const params = new URLSearchParams(ctx.rawBody);
  const isValid = validateTwilioSignature(authToken, signature, verificationUrl, params);
  if (isValid) {
    const replayKey = createTwilioReplayKey({
      verificationUrl,
      signature,
      requestParams: params
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }
  const variants = /* @__PURE__ */ new Set();
  variants.add(verificationUrl);
  variants.add(stripPortFromUrl(verificationUrl));
  if (options?.publicUrl) {
    try {
      const publicPort = new URL(options.publicUrl).port;
      if (publicPort) {
        variants.add(setPortOnUrl(verificationUrl, publicPort));
      }
    } catch {
    }
  }
  const hostHeaderPort = extractPortFromHostHeader(getHeader(ctx.headers, "host"));
  if (hostHeaderPort) {
    variants.add(setPortOnUrl(verificationUrl, hostHeaderPort));
  }
  for (const candidateUrl of variants) {
    if (candidateUrl === verificationUrl) {
      continue;
    }
    const isValidCandidate = validateTwilioSignature(authToken, signature, candidateUrl, params);
    if (!isValidCandidate) {
      continue;
    }
    const replayKey = createTwilioReplayKey({
      verificationUrl: candidateUrl,
      signature,
      requestParams: params
    });
    const isReplay = markReplay(twilioReplayCache, replayKey);
    return { ok: true, verificationUrl: candidateUrl, isReplay, verifiedRequestKey: replayKey };
  }
  const isNgrokFreeTier = verificationUrl.includes(".ngrok-free.app") || verificationUrl.includes(".ngrok.io");
  return {
    ok: false,
    reason: `Invalid signature for URL: ${verificationUrl}`,
    verificationUrl,
    isNgrokFreeTier
  };
}
function normalizeSignatureBase64(input) {
  return Buffer.from(input, "base64").toString("base64");
}
function getBaseUrlNoQuery(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}
function timingSafeEqualString(a, b) {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    crypto.timingSafeEqual(dummy, dummy);
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function validatePlivoV2Signature(params) {
  const baseUrl = getBaseUrlNoQuery(params.url);
  const digest = crypto.createHmac("sha256", params.authToken).update(baseUrl + params.nonce).digest("base64");
  const expected = normalizeSignatureBase64(digest);
  const provided = normalizeSignatureBase64(params.signature);
  return timingSafeEqualString(expected, provided);
}
function toParamMapFromSearchParams(sp) {
  const map = {};
  for (const [key, value] of sp.entries()) {
    if (!map[key]) {
      map[key] = [];
    }
    map[key].push(value);
  }
  return map;
}
function sortedQueryString(params) {
  const parts = [];
  for (const key of Object.keys(params).toSorted()) {
    const values = [...params[key]].toSorted();
    for (const value of values) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join("&");
}
function sortedParamsString(params) {
  const parts = [];
  for (const key of Object.keys(params).toSorted()) {
    const values = [...params[key]].toSorted();
    for (const value of values) {
      parts.push(`${key}${value}`);
    }
  }
  return parts.join("");
}
function constructPlivoV3BaseUrl(params) {
  const hasPostParams = Object.keys(params.postParams).length > 0;
  const u = new URL(params.url);
  const baseNoQuery = `${u.protocol}//${u.host}${u.pathname}`;
  const queryMap = toParamMapFromSearchParams(u.searchParams);
  const queryString = sortedQueryString(queryMap);
  let baseUrl = baseNoQuery;
  if (queryString.length > 0 || hasPostParams) {
    baseUrl = `${baseNoQuery}?${queryString}`;
  }
  if (queryString.length > 0 && hasPostParams) {
    baseUrl = `${baseUrl}.`;
  }
  if (params.method === "GET") {
    return baseUrl;
  }
  return baseUrl + sortedParamsString(params.postParams);
}
function validatePlivoV3Signature(params) {
  const baseUrl = constructPlivoV3BaseUrl({
    method: params.method,
    url: params.url,
    postParams: params.postParams
  });
  const hmacBase = `${baseUrl}.${params.nonce}`;
  const digest = crypto.createHmac("sha256", params.authToken).update(hmacBase).digest("base64");
  const expected = normalizeSignatureBase64(digest);
  const provided = params.signatureHeader.split(",").map((s) => s.trim()).filter(Boolean).map((s) => normalizeSignatureBase64(s));
  for (const sig of provided) {
    if (timingSafeEqualString(expected, sig)) {
      return true;
    }
  }
  return false;
}
function verifyPlivoWebhook(ctx, authToken, options) {
  if (options?.skipVerification) {
    const replayKey = createSkippedVerificationReplayKey("plivo", ctx);
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return {
      ok: true,
      reason: "verification skipped (dev mode)",
      isReplay,
      verifiedRequestKey: replayKey
    };
  }
  const signatureV3 = getHeader(ctx.headers, "x-plivo-signature-v3");
  const nonceV3 = getHeader(ctx.headers, "x-plivo-signature-v3-nonce");
  const signatureV2 = getHeader(ctx.headers, "x-plivo-signature-v2");
  const nonceV2 = getHeader(ctx.headers, "x-plivo-signature-v2-nonce");
  const reconstructed = reconstructWebhookUrl(ctx, {
    allowedHosts: options?.allowedHosts,
    trustForwardingHeaders: options?.trustForwardingHeaders,
    trustedProxyIPs: options?.trustedProxyIPs,
    remoteIP: options?.remoteIP
  });
  let verificationUrl = reconstructed;
  if (options?.publicUrl) {
    try {
      const req = new URL(reconstructed);
      const base = new URL(options.publicUrl);
      base.pathname = req.pathname;
      base.search = req.search;
      verificationUrl = base.toString();
    } catch {
      verificationUrl = reconstructed;
    }
  }
  if (signatureV3 && nonceV3) {
    const method = ctx.method === "GET" || ctx.method === "POST" ? ctx.method : null;
    if (!method) {
      return {
        ok: false,
        version: "v3",
        verificationUrl,
        reason: `Unsupported HTTP method for Plivo V3 signature: ${ctx.method}`
      };
    }
    const postParams = toParamMapFromSearchParams(new URLSearchParams(ctx.rawBody));
    const ok = validatePlivoV3Signature({
      authToken,
      signatureHeader: signatureV3,
      nonce: nonceV3,
      method,
      url: verificationUrl,
      postParams
    });
    if (!ok) {
      return {
        ok: false,
        version: "v3",
        verificationUrl,
        reason: "Invalid Plivo V3 signature"
      };
    }
    const replayKey = `plivo:v3:${sha256Hex(`${verificationUrl}
${nonceV3}`)}`;
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return { ok: true, version: "v3", verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }
  if (signatureV2 && nonceV2) {
    const ok = validatePlivoV2Signature({
      authToken,
      signature: signatureV2,
      nonce: nonceV2,
      url: verificationUrl
    });
    if (!ok) {
      return {
        ok: false,
        version: "v2",
        verificationUrl,
        reason: "Invalid Plivo V2 signature"
      };
    }
    const replayKey = `plivo:v2:${sha256Hex(`${verificationUrl}
${nonceV2}`)}`;
    const isReplay = markReplay(plivoReplayCache, replayKey);
    return { ok: true, version: "v2", verificationUrl, isReplay, verifiedRequestKey: replayKey };
  }
  return {
    ok: false,
    reason: "Missing Plivo signature headers (V3 or V2)",
    verificationUrl
  };
}
export {
  reconstructWebhookUrl,
  validateTwilioSignature,
  verifyPlivoWebhook,
  verifyTelnyxWebhook,
  verifyTwilioWebhook
};
