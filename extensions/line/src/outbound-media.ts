import type { messagingApi } from "@line/bot-sdk";
import { getFileExtension, mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { isHttpsUrl } from "./media-url.js";
import type { LineOutboundMediaKind } from "./types.js";

type ResolveLineOutboundMediaOpts = {
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

const LINE_OUTBOUND_MEDIA_SSRF_POLICY: SsrFPolicy = {
  allowPrivateNetwork: false,
};

async function validateLineMediaUrl(url: string): Promise<void> {
  const parsed = URL.parse(url);
  if (!parsed) {
    throw new Error("LINE outbound media URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LINE outbound media URL must use HTTPS");
  }
  if (url.length > 2000) {
    throw new Error(`LINE outbound media URL must be 2000 chars or less (got ${url.length})`);
  }
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
  });
}

const LINE_MEDIA_KIND_BY_MIME: Readonly<Record<string, LineOutboundMediaKind | undefined>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "video/mp4": "video",
  "audio/mpeg": "audio",
  "audio/x-m4a": "audio",
};

// LINE's native message families accept narrower formats than the shared MIME
// families. A known but unsupported suffix must remain visible as text instead
// of becoming a native bubble the provider accepts but the client cannot render.
function detectLineMediaKindFromUrl(
  url: string,
): LineOutboundMediaKind | "unsupported" | undefined {
  const mimeType = mimeTypeFromFilePath(url);
  if (mimeType === undefined) {
    return getFileExtension(url) === undefined ? undefined : "unsupported";
  }
  return LINE_MEDIA_KIND_BY_MIME[mimeType] ?? "unsupported";
}

function resolveLineMediaKind(
  url: string,
  opts: ResolveLineOutboundMediaOpts,
): {
  mediaKind: LineOutboundMediaKind | "unsupported";
  kindSource: "declared" | "metadata" | "url" | "fallback";
} {
  if (opts.mediaKind !== undefined) {
    return { mediaKind: opts.mediaKind, kindSource: "declared" };
  }
  if (typeof opts.durationMs === "number") {
    return { mediaKind: "audio", kindSource: "metadata" };
  }
  if (opts.trackingId?.trim()) {
    return { mediaKind: "video", kindSource: "metadata" };
  }
  const detected = detectLineMediaKindFromUrl(url);
  return detected === undefined
    ? { mediaKind: "image", kindSource: "fallback" }
    : { mediaKind: detected, kindSource: "url" };
}

function isLineUserTarget(target: string): boolean {
  const normalized = target
    .trim()
    .replace(/^line:(group|room|user):/i, "")
    .replace(/^line:/i, "");
  return /^U/i.test(normalized);
}

// An image bubble LINE cannot fill renders as blank space the sender never sees,
// so media the platform will not carry degrades to the URL it was made of — the
// same shape createLocationMessage uses for a pin LINE will not draw.
// Reply-token and push delivery share media validation and provider payload construction.
export async function buildLineMediaMessage(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts,
  target: string,
): Promise<messagingApi.Message> {
  const trimmedUrl = mediaUrl.trim();
  if (!isHttpsUrl(trimmedUrl)) {
    throw new Error(
      URL.canParse(trimmedUrl)
        ? "LINE outbound media URL must use HTTPS"
        : "LINE outbound media currently requires a public HTTPS URL",
    );
  }
  await validateLineMediaUrl(trimmedUrl);
  const previewImageUrl = opts.previewImageUrl?.trim();
  if (previewImageUrl) {
    await validateLineMediaUrl(previewImageUrl);
  }
  const { mediaKind, kindSource } = resolveLineMediaKind(trimmedUrl, opts);
  switch (mediaKind) {
    case "unsupported":
      return { type: "text", text: trimmedUrl };
    case "video": {
      if (previewImageUrl) {
        return {
          type: "video",
          originalContentUrl: trimmedUrl,
          previewImageUrl,
          // LINE accepts tracking ids for users although its SDK omits the field.
          ...(isLineUserTarget(target) && opts.trackingId ? { trackingId: opts.trackingId } : {}),
        };
      }
      // LINE always needs a poster for a video. Explicit kind or video-only
      // metadata keeps the missing field visible; only URL inference degrades.
      if (kindSource !== "url") {
        throw new Error("LINE video messages require previewImageUrl to reference an image URL");
      }
      return { type: "text", text: trimmedUrl };
    }
    case "audio":
      return {
        type: "audio",
        originalContentUrl: trimmedUrl,
        duration: typeof opts.durationMs === "number" ? opts.durationMs : 60000,
      };
    default:
      return {
        type: "image",
        originalContentUrl: trimmedUrl,
        previewImageUrl: previewImageUrl || trimmedUrl,
      };
  }
}
