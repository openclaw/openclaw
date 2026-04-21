import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveWebhookPath } from "./runtime-api.js";

const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 60_000;
const ZALO_OUTBOUND_MEDIA_PREFIX = "/media/";

type HostedZaloMedia = {
  routePath: string;
  token: string;
  buffer: Buffer;
  contentType?: string;
  expiresAt: number;
};

const hostedZaloMedia = new Map<string, HostedZaloMedia>();

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function cleanupExpiredHostedZaloMedia(nowMs = Date.now()): void {
  for (const [id, entry] of hostedZaloMedia) {
    if (entry.expiresAt <= nowMs) {
      hostedZaloMedia.delete(id);
    }
  }
}

function createHostedZaloMediaId(): string {
  return randomBytes(12).toString("hex");
}

function createHostedZaloMediaToken(): string {
  return randomBytes(24).toString("hex");
}

function resolveHostedZaloMediaRoutePath(params: {
  webhookUrl: string;
  webhookPath?: string;
}): string {
  const webhookRoutePath = resolveWebhookPath({
    webhookPath: params.webhookPath,
    webhookUrl: params.webhookUrl,
    defaultPath: null,
  });
  if (!webhookRoutePath) {
    throw new Error("Zalo webhookPath could not be derived for outbound media hosting");
  }
  return `${trimTrailingSlash(webhookRoutePath)}${ZALO_OUTBOUND_MEDIA_PREFIX}`;
}

export async function prepareHostedZaloMediaUrl(params: {
  mediaUrl: string;
  webhookUrl: string;
  webhookPath?: string;
  maxBytes: number;
}): Promise<string> {
  cleanupExpiredHostedZaloMedia();

  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
  });

  const routePath = resolveHostedZaloMediaRoutePath({
    webhookUrl: params.webhookUrl,
    webhookPath: params.webhookPath,
  });
  const id = createHostedZaloMediaId();
  const token = createHostedZaloMediaToken();
  const publicBaseUrl = new URL(params.webhookUrl).origin;

  hostedZaloMedia.set(id, {
    routePath,
    token,
    buffer: media.buffer,
    contentType: media.contentType,
    expiresAt: Date.now() + ZALO_OUTBOUND_MEDIA_TTL_MS,
  });

  return `${publicBaseUrl}${routePath}${id}?token=${token}`;
}

export async function tryHandleHostedZaloMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  cleanupExpiredHostedZaloMedia();

  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    return false;
  }

  const mediaPath = url.pathname;
  const prefixIndex = mediaPath.lastIndexOf(ZALO_OUTBOUND_MEDIA_PREFIX);
  if (prefixIndex < 0) {
    return false;
  }

  const routePath = mediaPath.slice(0, prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
  const id = mediaPath.slice(prefixIndex + ZALO_OUTBOUND_MEDIA_PREFIX.length);
  if (!id) {
    return false;
  }

  const entry = hostedZaloMedia.get(id);
  if (!entry || entry.routePath !== routePath) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (entry.expiresAt <= Date.now()) {
    hostedZaloMedia.delete(id);
    res.statusCode = 410;
    res.end("Expired");
    return true;
  }

  if (url.searchParams.get("token") !== entry.token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  if (entry.contentType) {
    res.setHeader("Content-Type", entry.contentType);
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.end(entry.buffer);
  hostedZaloMedia.delete(id);
  return true;
}

export function clearHostedZaloMediaForTest(): void {
  hostedZaloMedia.clear();
}
