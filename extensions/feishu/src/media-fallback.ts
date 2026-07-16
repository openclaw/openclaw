import {
  isBlockedHostnameOrIp,
  resolvePinnedHostnameWithPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT = "Media upload failed. Please try again.";

async function resolvePublicFeishuMediaReference(
  value: string | undefined,
): Promise<string | undefined> {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    if (isBlockedHostnameOrIp(parsed.hostname)) {
      return undefined;
    }
    await resolvePinnedHostnameWithPolicy(parsed.hostname);
    return raw;
  } catch {
    return undefined;
  }
}

export async function buildFeishuMediaFallbackText(params: {
  text?: string;
  mediaUrl?: string;
  mediaLinkStyle?: "attachment" | "plain";
}): Promise<string> {
  const mediaUrl = await resolvePublicFeishuMediaReference(params.mediaUrl);
  const attachmentText = mediaUrl
    ? `${params.mediaLinkStyle === "plain" ? "" : "📎 "}${mediaUrl}`
    : FEISHU_MEDIA_UPLOAD_FAILURE_FALLBACK_TEXT;
  return [params.text?.trim(), attachmentText].filter(Boolean).join("\n\n");
}
