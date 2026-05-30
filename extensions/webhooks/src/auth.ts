import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ConfiguredWebhookAuth } from "./config.js";

export type WebhookHeaderMap = Record<string, string>;

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export function collectHeadersFromRecord(
  input: Record<string, string | string[] | number | boolean | null | undefined> | undefined,
): WebhookHeaderMap {
  const headers: WebhookHeaderMap = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalizedName = normalizeLowercaseStringOrEmpty(name);
    if (!normalizedName || value === undefined || value === null) {
      continue;
    }
    const firstValue = Array.isArray(value) ? (value[0] ?? "") : String(value);
    headers[normalizedName] = firstValue.trim();
  }
  return headers;
}

export function collectRequestHeaders(req: IncomingMessage): Record<string, string> {
  return collectHeadersFromRecord(req.headers);
}

export function getHeaderFromHeaders(headers: WebhookHeaderMap, name: string): string {
  return headers[normalizeLowercaseStringOrEmpty(name)] ?? "";
}

export function getHeader(req: IncomingMessage, name: string): string {
  return firstHeaderValue(req.headers[normalizeLowercaseStringOrEmpty(name)]).trim();
}

function extractBearerSecret(headers: WebhookHeaderMap, prefix: string): string {
  const authHeader = headers.authorization ?? "";
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  const normalizedAuthHeader = normalizeLowercaseStringOrEmpty(authHeader);
  const tokenPrefix = `${normalizedPrefix} `;
  if (normalizedPrefix.length > 0 && normalizedAuthHeader.startsWith(tokenPrefix)) {
    return authHeader.slice(prefix.length + 1).trim();
  }
  return "";
}

export function extractPresentedSecretFromHeaders(params: {
  headers: WebhookHeaderMap;
  auth: ConfiguredWebhookAuth;
}): string {
  const { headers, auth } = params;
  if (auth.mode === "bearer") {
    const bearerSecret = extractBearerSecret(headers, auth.prefix);
    if (bearerSecret || !auth.legacySharedHeader) {
      return bearerSecret;
    }
    return getHeaderFromHeaders(headers, "x-openclaw-webhook-secret");
  }
  const value = getHeaderFromHeaders(headers, auth.header);
  if (!auth.prefix) {
    return value;
  }
  return value.startsWith(auth.prefix) ? value.slice(auth.prefix.length).trim() : "";
}

export function extractPresentedSecret(params: {
  req: IncomingMessage;
  auth: ConfiguredWebhookAuth;
}): string {
  return extractPresentedSecretFromHeaders({
    headers: collectRequestHeaders(params.req),
    auth: params.auth,
  });
}

export function timingSafeEquals(left: string, right: string): boolean {
  return safeEqualSecret(left, right);
}

function timingSafeAsciiEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length);
  const paddedLeft = Buffer.alloc(maxLength);
  const paddedRight = Buffer.alloc(maxLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  const equal = timingSafeEqual(paddedLeft, paddedRight);
  return leftBuffer.length === rightBuffer.length && equal;
}

export function hmacMatches(params: {
  rawBody: string;
  secret: string;
  presentedSignature: string;
}): boolean {
  const expected = createHmac("sha256", params.secret).update(params.rawBody).digest("hex");
  return timingSafeAsciiEquals(
    normalizeLowercaseStringOrEmpty(expected),
    normalizeLowercaseStringOrEmpty(params.presentedSignature),
  );
}
