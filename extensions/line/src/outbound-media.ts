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

function inferMimeTypeFromUrl(url: string): string {
  let pathname = "";
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    const hashStripped = url.split("#")[0] ?? "";
    pathname = (hashStripped.split("?")[0] ?? "").toLowerCase();
  }

  if (/\.(jpe?g|png|gif|webp)$/.test(pathname)) {
    return "image/jpeg";
  }
  if (/\.(mp4|mov|m4v|webm)$/.test(pathname)) {
    return "video/mp4";
  }
  if (/\.(mp3|m4a|aac|wav|ogg)$/.test(pathname)) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function resolveLineOutboundMedia(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts = {},
): Promise<LineOutboundMediaResolved> {
  const trimmedUrl = mediaUrl.trim();
  if (isHttpsUrl(trimmedUrl)) {
    validateLineMediaUrl(trimmedUrl);
    const mediaKind = opts.mediaKind ?? detectLineMediaKind(inferMimeTypeFromUrl(trimmedUrl));
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
