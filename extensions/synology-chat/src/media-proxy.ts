import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import ipaddr from "ipaddr.js";
import { fetchRemoteMedia, MEDIA_MAX_BYTES } from "openclaw/plugin-sdk/media-runtime";
import { isPrivateOrLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedSynologyChatAccount } from "./types.js";

const MEDIA_PROXY_SEGMENT = "__openclaw-media";
const HOSTED_MEDIA_TTL_MS = 10 * 60 * 1000;
const MAX_HOSTED_MEDIA_ENTRIES = 128;
const SYNOLOGY_HOSTED_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const HOSTED_MEDIA_MAX_BYTES = Math.max(MEDIA_MAX_BYTES, SYNOLOGY_HOSTED_MEDIA_MAX_BYTES);
const HOSTED_MEDIA_TOTAL_MAX_BYTES = 64 * 1024 * 1024;

type SynologyHostedMedia = Awaited<ReturnType<typeof fetchRemoteMedia>> & {
  accountId: string;
  expiresAt: number;
  createdAt: number;
};

type SynologyMediaProxyState = {
  publicOrigin?: string;
  transportRegistered: boolean;
};

const hostedMedia = new Map<string, SynologyHostedMedia>();
const mediaProxyStateByAccountId = new Map<string, SynologyMediaProxyState>();

function getOrCreateMediaProxyState(account: ResolvedSynologyChatAccount): SynologyMediaProxyState {
  const existingState = mediaProxyStateByAccountId.get(account.accountId);
  if (existingState) {
    return existingState;
  }

  const state: SynologyMediaProxyState = {
    publicOrigin:
      normalizeSynologyPublicOrigin(account.publicOrigin) ??
      normalizeSynologyPublicOrigin(process.env.OPENCLAW_GATEWAY_URL),
    transportRegistered: false,
  };
  mediaProxyStateByAccountId.set(account.accountId, state);
  return state;
}

function normalizeHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isBlockedSpecialIpLiteral(hostname: string): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  if (!ipaddr.isValid(normalizedHostname)) {
    return false;
  }

  const parsed = ipaddr.parse(normalizedHostname);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      return ipv6.toIPv4Address().range() === "unspecified";
    }
  }

  return parsed.range() === "unspecified";
}

function isIpLiteral(hostname: string): boolean {
  return ipaddr.isValid(normalizeHostname(hostname));
}

function parseHttpUrl(sourceUrl: string): URL | null {
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeSynologyPublicOrigin(candidate: string | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  let protocol: "http:" | "https:";
  if (parsed.protocol === "ws:" || parsed.protocol === "http:") {
    protocol = "http:";
  } else if (parsed.protocol === "wss:" || parsed.protocol === "https:") {
    protocol = "https:";
  } else {
    return undefined;
  }

  if (
    !parsed.hostname ||
    isPrivateOrLoopbackHost(parsed.hostname) ||
    isBlockedSpecialIpLiteral(parsed.hostname)
  ) {
    return undefined;
  }

  parsed.protocol = protocol;
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function isDirectPublicIpLiteralUrl(parsed: URL): boolean {
  return (
    !!parsed.hostname &&
    isIpLiteral(parsed.hostname) &&
    !isBlockedSpecialIpLiteral(parsed.hostname) &&
    !isPrivateOrLoopbackHost(parsed.hostname)
  );
}

function cleanupExpiredHostedMedia(nowMs = Date.now()): void {
  for (const [token, entry] of hostedMedia) {
    if (entry.expiresAt <= nowMs) {
      hostedMedia.delete(token);
    }
  }
}

function getHostedMediaTotalBytes(): number {
  let totalBytes = 0;
  for (const entry of hostedMedia.values()) {
    totalBytes += entry.buffer.length;
  }
  return totalBytes;
}

function trimHostedMediaCache(): void {
  if (
    hostedMedia.size <= MAX_HOSTED_MEDIA_ENTRIES &&
    getHostedMediaTotalBytes() <= HOSTED_MEDIA_TOTAL_MAX_BYTES
  ) {
    return;
  }

  const entries = [...hostedMedia.entries()].toSorted((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [token] of entries) {
    if (
      hostedMedia.size <= MAX_HOSTED_MEDIA_ENTRIES &&
      getHostedMediaTotalBytes() <= HOSTED_MEDIA_TOTAL_MAX_BYTES
    ) {
      break;
    }
    hostedMedia.delete(token);
  }
}

function buildContentDisposition(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const sanitized = fileName.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
  return sanitized ? `inline; filename="${sanitized}"` : undefined;
}

function resolveForwardedHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    value = value[value.length - 1];
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value
    .split(",")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.length > 0);
  return trimmed || undefined;
}

export function getSynologyHostedMediaPathPrefix(account: ResolvedSynologyChatAccount): string {
  return `${account.webhookPath.replace(/\/+$/, "")}/${MEDIA_PROXY_SEGMENT}/`;
}

export function registerSynologyHostedMediaTransport(account: ResolvedSynologyChatAccount): void {
  const state = getOrCreateMediaProxyState(account);
  state.transportRegistered = true;
  state.publicOrigin ||= normalizeSynologyPublicOrigin(account.publicOrigin);
  state.publicOrigin ||= normalizeSynologyPublicOrigin(process.env.OPENCLAW_GATEWAY_URL);
}

export function unregisterSynologyHostedMediaTransport(account: ResolvedSynologyChatAccount): void {
  mediaProxyStateByAccountId.delete(account.accountId);
  for (const [token, entry] of hostedMedia) {
    if (entry.accountId === account.accountId) {
      hostedMedia.delete(token);
    }
  }
}

export function rememberSynologyHostedMediaOrigin(
  account: ResolvedSynologyChatAccount,
  origin: string,
): void {
  const state = mediaProxyStateByAccountId.get(account.accountId);
  if (!state) {
    return;
  }
  const normalizedOrigin = normalizeSynologyPublicOrigin(origin);
  if (!normalizedOrigin) {
    return;
  }
  state.publicOrigin = normalizedOrigin;
}

export function deriveSynologyPublicOrigin(req: IncomingMessage): string | undefined {
  const host = resolveForwardedHeaderValue(req.headers["x-forwarded-host"]);
  if (!host) {
    return undefined;
  }

  const proto = resolveForwardedHeaderValue(req.headers["x-forwarded-proto"]);
  if (proto !== "http" && proto !== "https") {
    return undefined;
  }

  try {
    return normalizeSynologyPublicOrigin(new URL(`${proto}://${host}`).origin);
  } catch {
    return undefined;
  }
}

async function hostSynologyMediaUrl(params: {
  account: ResolvedSynologyChatAccount;
  sourceUrl: string;
  publicOrigin: string;
}): Promise<string | null> {
  cleanupExpiredHostedMedia();
  const media = await fetchRemoteMedia({
    url: params.sourceUrl,
    maxBytes: HOSTED_MEDIA_MAX_BYTES,
  }).catch(() => null);
  if (!media) {
    return null;
  }

  const token = randomUUID();
  const nowMs = Date.now();
  hostedMedia.set(token, {
    ...media,
    accountId: params.account.accountId,
    createdAt: nowMs,
    expiresAt: nowMs + HOSTED_MEDIA_TTL_MS,
  });
  trimHostedMediaCache();
  return `${params.publicOrigin}${getSynologyHostedMediaPathPrefix(params.account)}${token}`;
}

export async function resolveSynologyWebhookFileUrl(params: {
  account: ResolvedSynologyChatAccount;
  sourceUrl: string;
}): Promise<string | null> {
  const parsed = parseHttpUrl(params.sourceUrl);
  if (!parsed?.hostname) {
    return null;
  }

  const transportState = getOrCreateMediaProxyState(params.account);
  if (transportState.transportRegistered && transportState.publicOrigin) {
    return await hostSynologyMediaUrl({
      account: params.account,
      sourceUrl: params.sourceUrl,
      publicOrigin: transportState.publicOrigin,
    });
  }

  return isDirectPublicIpLiteralUrl(parsed) ? params.sourceUrl : null;
}

export function createSynologyHostedMediaHandler(account: ResolvedSynologyChatAccount) {
  const pathPrefix = getSynologyHostedMediaPathPrefix(account);
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end();
      return;
    }

    cleanupExpiredHostedMedia();
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!pathname.startsWith(pathPrefix)) {
      res.writeHead(404);
      res.end();
      return;
    }

    const token = pathname.slice(pathPrefix.length).split("/")[0]?.trim();
    if (!token) {
      res.writeHead(404);
      res.end();
      return;
    }

    const entry = hostedMedia.get(token);
    if (!entry || entry.accountId !== account.accountId || entry.expiresAt <= Date.now()) {
      if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
        hostedMedia.delete(token);
      }
      res.writeHead(404);
      res.end();
      return;
    }

    const headers: Record<string, string | number> = {
      "Cache-Control": "private, max-age=300",
      "Content-Length": entry.buffer.length,
    };
    if (entry.contentType) {
      headers["Content-Type"] = entry.contentType;
    }
    const disposition = buildContentDisposition(entry.fileName);
    if (disposition) {
      headers["Content-Disposition"] = disposition;
    }

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(entry.buffer);
  };
}

export function clearSynologyHostedMediaStateForTest(): void {
  hostedMedia.clear();
  mediaProxyStateByAccountId.clear();
}
