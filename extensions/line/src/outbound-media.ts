import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  fetchWithSsrFGuard,
  resolvePinnedHostnameWithPolicy,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type LineOutboundMediaKind = "image" | "video" | "audio";

// "preview" covers previewImageUrl payloads on image/video messages, which
// LINE caps at 1 MB (smaller than the 10 MB / 200 MB caps that apply to the
// originalContentUrl). It is not a message-level media kind, so it is kept
// out of LineOutboundMediaKind / LineOutboundMediaResolved.mediaKind.
type LineOutboundMediaSizeKind = LineOutboundMediaKind | "preview";

export type LineOutboundMediaResolved = {
  mediaUrl: string;
  mediaKind: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

type ResolveLineOutboundMediaOpts = {
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
};

const LINE_OUTBOUND_MEDIA_SSRF_POLICY: SsrFPolicy = {
  allowPrivateNetwork: false,
};

// Verified against developers.line.biz/en/reference/messaging-api/ on 2026-05-20.
// Image message originalContentUrl: "Max file size: 10MB".
// Video / audio message originalContentUrl: "Max file size: 200 MB".
// previewImageUrl (image / video messages): "Max file size: 1 MB" — strictly
// smaller than the originalContentUrl cap, so it has to be checked separately.
export const LINE_OUTBOUND_MEDIA_MAX_BYTES: Record<LineOutboundMediaSizeKind, number> = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 200 * 1024 * 1024,
  preview: 1 * 1024 * 1024,
};

const LINE_OUTBOUND_MEDIA_PRECHECK_TIMEOUT_MS = 5000;

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PrecheckLineOutboundMediaSizeOpts = {
  fetchImpl?: FetchImpl;
};

function redactLineOutboundMediaUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "<invalid-url>";
  }
}

export async function precheckLineOutboundMediaSize(
  url: string,
  kind: LineOutboundMediaSizeKind,
  opts: PrecheckLineOutboundMediaSizeOpts = {},
): Promise<void> {
  const cap = LINE_OUTBOUND_MEDIA_MAX_BYTES[kind];
  const redacted = redactLineOutboundMediaUrl(url);

  let response: Response;
  let release: () => Promise<void>;
  try {
    const guarded = await fetchWithSsrFGuard({
      url,
      init: { method: "HEAD" },
      requireHttps: true,
      mode: "strict",
      policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
      timeoutMs: LINE_OUTBOUND_MEDIA_PRECHECK_TIMEOUT_MS,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    response = guarded.response;
    release = guarded.release;
  } catch {
    logVerbose(`line: outbound media-size precheck skipped (probe failed): ${redacted}`);
    return;
  }

  try {
    if (response.status !== 200 && response.status !== 206) {
      logVerbose(
        `line: outbound media-size precheck skipped (status ${response.status}): ${redacted}`,
      );
      return;
    }

    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader === null) {
      logVerbose(`line: outbound media-size precheck skipped (no content-length): ${redacted}`);
      return;
    }

    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0) {
      logVerbose(
        `line: outbound media-size precheck skipped (malformed content-length ${lengthHeader}): ${redacted}`,
      );
      return;
    }

    if (length > cap) {
      throw new Error(
        `LINE ${kind} media must be ≤${cap} bytes (got ${length} bytes from ${redacted})`,
      );
    }
  } finally {
    await release();
  }
}

export async function validateLineMediaUrl(url: string): Promise<void> {
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
  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: LINE_OUTBOUND_MEDIA_SSRF_POLICY,
  });
}

export function detectLineMediaKind(mimeType: string): LineOutboundMediaKind {
  const normalized = normalizeLowercaseStringOrEmpty(mimeType);
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return "image";
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function detectLineMediaKindFromUrl(url: string): LineOutboundMediaKind | undefined {
  try {
    const pathname = normalizeLowercaseStringOrEmpty(new URL(url).pathname);
    if (/\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(pathname)) {
      return "image";
    }
    if (/\.(mp4|mov|m4v|webm)$/i.test(pathname)) {
      return "video";
    }
    if (/\.(mp3|m4a|aac|wav|ogg|oga)$/i.test(pathname)) {
      return "audio";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function resolveLineOutboundMedia(
  mediaUrl: string,
  opts: ResolveLineOutboundMediaOpts = {},
): Promise<LineOutboundMediaResolved> {
  const trimmedUrl = mediaUrl.trim();
  if (isHttpsUrl(trimmedUrl)) {
    await validateLineMediaUrl(trimmedUrl);
    const previewImageUrl = opts.previewImageUrl?.trim();
    if (previewImageUrl) {
      await validateLineMediaUrl(previewImageUrl);
    }
    const mediaKind =
      opts.mediaKind ??
      (typeof opts.durationMs === "number" ? "audio" : undefined) ??
      (opts.trackingId?.trim() ? "video" : undefined) ??
      detectLineMediaKindFromUrl(trimmedUrl) ??
      "image";
    if (previewImageUrl && previewImageUrl === trimmedUrl) {
      // Same URL serves as both originalContentUrl and previewImageUrl;
      // dedupe to one HEAD probe but evaluate against the stricter preview cap.
      await precheckLineOutboundMediaSize(trimmedUrl, "preview");
    } else {
      await precheckLineOutboundMediaSize(trimmedUrl, mediaKind);
      if (previewImageUrl) {
        await precheckLineOutboundMediaSize(previewImageUrl, "preview");
      }
    }
    return {
      mediaUrl: trimmedUrl,
      mediaKind,
      ...(previewImageUrl ? { previewImageUrl } : {}),
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
  }
  throw new Error("LINE outbound media currently requires a public HTTPS URL");
}
