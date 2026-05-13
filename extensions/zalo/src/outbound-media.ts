import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { createPluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";

const ZALO_OUTBOUND_MEDIA_TTL_MS = 2 * 60_000;
const ZALO_OUTBOUND_MEDIA_MAX_ENTRIES = 100;
const ZALO_OUTBOUND_MEDIA_SEGMENT = "media";
const ZALO_OUTBOUND_MEDIA_PREFIX = `/${ZALO_OUTBOUND_MEDIA_SEGMENT}/`;
const ZALO_OUTBOUND_MEDIA_ID_RE = /^[a-f0-9]{24}$/;

type HostedZaloMediaMetadata = {
  routePath: string;
  token: string;
  contentType?: string;
  expiresAt: number;
};

const hostedZaloMediaStore = createPluginBlobStore<HostedZaloMediaMetadata>("zalo", {
  namespace: "outbound-media",
  maxEntries: ZALO_OUTBOUND_MEDIA_MAX_ENTRIES,
});

function createHostedZaloMediaId(): string {
  return randomBytes(12).toString("hex");
}

function createHostedZaloMediaToken(): string {
  return randomBytes(24).toString("hex");
}

async function deleteHostedZaloMediaEntry(id: string): Promise<void> {
  await hostedZaloMediaStore.delete(id);
}

async function cleanupExpiredHostedZaloMedia(nowMs = Date.now()): Promise<void> {
  const entries = await hostedZaloMediaStore.entries();
  await Promise.all(
    entries
      .filter((entry) => entry.metadata.expiresAt <= nowMs)
      .map((entry) => hostedZaloMediaStore.delete(entry.key)),
  );
}

async function readHostedZaloMediaEntry(id: string): Promise<{
  metadata: HostedZaloMediaMetadata;
  buffer: Buffer;
} | null> {
  const entry = await hostedZaloMediaStore.lookup(id);
  if (!entry) {
    return null;
  }
  return {
    metadata: entry.metadata,
    buffer: entry.blob,
  };
}

export function resolveHostedZaloMediaRoutePrefix(params: {
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
  return webhookRoutePath === "/"
    ? `/${ZALO_OUTBOUND_MEDIA_SEGMENT}`
    : `${webhookRoutePath}/${ZALO_OUTBOUND_MEDIA_SEGMENT}`;
}

function resolveHostedZaloMediaRoutePath(params: {
  webhookUrl: string;
  webhookPath?: string;
}): string {
  return `${resolveHostedZaloMediaRoutePrefix(params)}/`;
}

export async function prepareHostedZaloMediaUrl(params: {
  mediaUrl: string;
  webhookUrl: string;
  webhookPath?: string;
  maxBytes: number;
  proxyUrl?: string;
}): Promise<string> {
  await cleanupExpiredHostedZaloMedia();

  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: params.maxBytes,
    ...(params.proxyUrl ? { proxyUrl: params.proxyUrl } : {}),
  });

  const routePath = resolveHostedZaloMediaRoutePath({
    webhookUrl: params.webhookUrl,
    webhookPath: params.webhookPath,
  });
  const id = createHostedZaloMediaId();
  const token = createHostedZaloMediaToken();
  const publicBaseUrl = new URL(params.webhookUrl).origin;

  await hostedZaloMediaStore.register(
    id,
    {
      routePath,
      token,
      contentType: media.contentType,
      expiresAt: Date.now() + ZALO_OUTBOUND_MEDIA_TTL_MS,
    } satisfies HostedZaloMediaMetadata,
    media.buffer,
  );

  return `${publicBaseUrl}${routePath}${id}?token=${token}`;
}

export async function tryHandleHostedZaloMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  await cleanupExpiredHostedZaloMedia();

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
  if (!id || !ZALO_OUTBOUND_MEDIA_ID_RE.test(id)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const entry = await readHostedZaloMediaEntry(id);
  if (!entry || entry.metadata.routePath !== routePath) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (entry.metadata.expiresAt <= Date.now()) {
    await deleteHostedZaloMediaEntry(id);
    res.statusCode = 410;
    res.end("Expired");
    return true;
  }

  if (url.searchParams.get("token") !== entry.metadata.token) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  if (entry.metadata.contentType) {
    res.setHeader("Content-Type", entry.metadata.contentType);
  }
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", String(entry.buffer.byteLength));

  if (method === "HEAD") {
    res.statusCode = 200;
    res.end();
    return true;
  }

  res.statusCode = 200;
  res.end(entry.buffer);
  await deleteHostedZaloMediaEntry(id);
  return true;
}

export async function clearHostedZaloMediaForTest(): Promise<void> {
  await hostedZaloMediaStore.clear();
}
