import {
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { LocalMediaAccessError } from "openclaw/plugin-sdk/web-media";

const FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT = "Media upload failed. Please try again.";

const PRIVATE_MEDIA_FETCH_FAILURE_RE =
  /\b(?:LocalMediaAccessError|SsrFBlockedError|Blocked hostname|private\/internal|special-use IP address|local media path|invalid-file-url|network-path-not-allowed|path-not-allowed|Host media read requires explicit localRoots)\b/i;

export function buildFeishuMediaUploadFailureFallbackText(params: { text?: string }): string {
  const text = params.text?.trim();
  return [text, FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT].filter(Boolean).join("\n\n");
}

export async function isPublicFeishuMediaReference(value: string): Promise<boolean> {
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      return false;
    }
    await resolvePinnedHostnameWithPolicy(parsed.hostname);
    return true;
  } catch {
    return false;
  }
}

function* walkErrorChain(error: unknown, seen = new Set()): Generator {
  if (error === null || error === undefined || seen.has(error)) {
    return;
  }
  seen.add(error);
  yield error;
  if (typeof error !== "object") {
    return;
  }
  const record = error as {
    cause?: unknown;
    primaryError?: unknown;
    attemptErrors?: unknown;
  };
  yield* walkErrorChain(record.cause, seen);
  yield* walkErrorChain(record.primaryError, seen);
  const attemptErrors = Array.isArray(record.attemptErrors) ? record.attemptErrors : [];
  for (const attemptError of attemptErrors) {
    yield* walkErrorChain(attemptError, seen);
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return typeof error === "string" ? error : "";
}

export function isPrivateFeishuMediaFetchFailure(error: unknown): boolean {
  for (const entry of walkErrorChain(error)) {
    if (entry instanceof LocalMediaAccessError || entry instanceof SsrFBlockedError) {
      return true;
    }
    if (PRIVATE_MEDIA_FETCH_FAILURE_RE.test(errorText(entry))) {
      return true;
    }
  }
  return false;
}

export async function buildFeishuMediaFallbackText(params: {
  text?: string;
  mediaUrl?: string;
  error?: unknown;
}): Promise<string> {
  const mediaUrl = params.mediaUrl?.trim();
  if (
    mediaUrl &&
    !isPrivateFeishuMediaFetchFailure(params.error) &&
    (await isPublicFeishuMediaReference(mediaUrl))
  ) {
    const text = params.text?.trim();
    return [text, `📎 ${mediaUrl}`].filter(Boolean).join("\n\n");
  }
  return buildFeishuMediaUploadFailureFallbackText({ text: params.text });
}
