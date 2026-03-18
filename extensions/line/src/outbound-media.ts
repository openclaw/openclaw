import { fetchWithSsrFGuard, withStrictGuardedFetchMode } from "openclaw/plugin-sdk/infra-runtime";

export type LineOutboundMediaKind = "image" | "video" | "audio";

export type LineOutboundMediaResolved = {
  mediaUrl: string;
  mediaKind: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

type ResolveLineOutboundMediaOpts = {
  mediaBaseUrl?: string;
  mediaLocalRoots?: readonly string[];
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

export const LINE_MEDIA_KIND_PROBE_TIMEOUT_MS = 2000;

export function validateLineMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`LINE outbound media URL must be a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`LINE outbound media URL must use HTTPS: ${url}`);
  }
  if (url.length > 2000) {
    throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
  }
}

export function detectLineMediaKind(mimeType: string): LineOutboundMediaKind {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  // Fallback to image to stay within LINE API media type constraints.
  return "image";
}

function detectKnownLineMediaKind(mimeType: string): LineOutboundMediaKind | undefined {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return undefined;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function parseResponseMimeType(contentType: string | null): string | undefined {
  const raw = contentType?.split(";")[0]?.trim().toLowerCase();
  return raw || undefined;
}

async function fetchMimeTypeWithTimeout(
  url: string,
  method: "HEAD" | "GET",
): Promise<string | undefined> {
  try {
    const { response, release } = await fetchWithSsrFGuard(
      withStrictGuardedFetchMode({
        url,
        init: {
          method,
          ...(method === "GET" ? { headers: { Range: "bytes=0-0" } } : {}),
        },
        timeoutMs: LINE_MEDIA_KIND_PROBE_TIMEOUT_MS,
      }),
    );
    try {
      return parseResponseMimeType(response.headers.get("content-type"));
    } finally {
      await release();
    }
  } catch {
    return undefined;
  }
}

async function detectMediaKindFromRemote(url: string): Promise<LineOutboundMediaKind | undefined> {
  const headMimeType = await fetchMimeTypeWithTimeout(url, "HEAD");
  const fromHead = headMimeType ? detectKnownLineMediaKind(headMimeType) : undefined;
  if (fromHead) {
    return fromHead;
  }

  const getMimeType = await fetchMimeTypeWithTimeout(url, "GET");
  return getMimeType ? detectKnownLineMediaKind(getMimeType) : undefined;
}

export async function resolveLineOutboundMedia(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts = {},
): Promise<LineOutboundMediaResolved> {
  const trimmedUrl = mediaUrl.trim();
  if (isHttpsUrl(trimmedUrl)) {
    validateLineMediaUrl(trimmedUrl);
    const mediaKind = opts.mediaKind ?? (await detectMediaKindFromRemote(trimmedUrl)) ?? "image";
    return {
      mediaUrl: trimmedUrl,
      mediaKind,
      ...(opts.previewImageUrl ? { previewImageUrl: opts.previewImageUrl } : {}),
      ...(typeof opts.durationMs === "number" ? { durationMs: opts.durationMs } : {}),
      ...(opts.trackingId ? { trackingId: opts.trackingId } : {}),
    };
  }

  try {
    const parsed = new URL(trimmedUrl);
    if (parsed.protocol !== "https:") {
      throw new Error(`LINE outbound media URL must use HTTPS: ${trimmedUrl}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("LINE outbound")) {
      throw e;
    }
    // URL parse failure means this may be a local path; fall through to the HTTPS-only error.
  }
  void opts.mediaLocalRoots;
  void opts.mediaBaseUrl;
  throw new Error("LINE outbound media requires a publicly accessible HTTPS URL");
}
