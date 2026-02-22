import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk";
import { getSimplexRuntime } from "./runtime.js";
import type { SimplexComposedMessage, SimplexMsgContent } from "./simplex-commands.js";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export function resolveSimplexMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): number {
  return (
    resolveChannelMediaMaxBytes({
      cfg: params.cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.simplex?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.simplex?.mediaMaxMb,
      accountId: params.accountId,
    }) ?? DEFAULT_MAX_BYTES
  );
}

export async function resolveMediaPath(params: {
  mediaUrl: string;
  maxBytes: number;
}): Promise<{ path: string; contentType?: string; fileName?: string }> {
  const core = getSimplexRuntime();
  const mediaUrlLower = params.mediaUrl.toLowerCase();
  if (mediaUrlLower.startsWith("http:") || mediaUrlLower.startsWith("https:")) {
    const fetched = await core.channel.media.fetchRemoteMedia({
      url: params.mediaUrl,
      maxBytes: params.maxBytes,
      filePathHint: params.mediaUrl,
    });
    const saved = await core.channel.media.saveMediaBuffer(
      fetched.buffer,
      fetched.contentType,
      "simplex",
      params.maxBytes,
      fetched.fileName,
    );
    return { path: saved.path, contentType: saved.contentType, fileName: fetched.fileName };
  }
  const contentType = await core.media.detectMime({ filePath: params.mediaUrl });
  const fileName = path.basename(params.mediaUrl);
  return { path: params.mediaUrl, contentType, fileName };
}

export function buildMediaMsgContent(params: {
  text: string;
  mediaPath: string;
  contentType?: string;
  fileName?: string;
  audioAsVoice?: boolean;
}): SimplexMsgContent {
  const core = getSimplexRuntime();
  const contentType = params.contentType?.split(";")[0]?.trim();
  const mediaKind = contentType ? core.media.mediaKindFromMime(contentType) : "unknown";
  const voiceCompatible = core.media.isVoiceCompatibleAudio({
    contentType,
    fileName: params.fileName,
  });
  const wantsVoice = params.audioAsVoice === true && (mediaKind === "audio" || voiceCompatible);

  if (mediaKind === "image") {
    return {
      type: "image",
      text: params.text,
      image: params.fileName ?? params.mediaPath,
    };
  }
  if (mediaKind === "video") {
    return {
      type: "video",
      text: params.text,
      image: params.fileName ?? "",
      duration: 0,
    };
  }
  if (wantsVoice) {
    return {
      type: "voice",
      text: params.text,
      duration: 0,
    };
  }
  return {
    type: "file",
    text: params.text,
  };
}

export async function buildComposedMessages(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  audioAsVoice?: boolean;
}): Promise<SimplexComposedMessage[]> {
  const text = params.text ?? "";
  const mediaList = params.mediaUrls?.length
    ? params.mediaUrls
    : params.mediaUrl
      ? [params.mediaUrl]
      : [];
  const composedMessages: SimplexComposedMessage[] = [];

  if (mediaList.length === 0) {
    if (text) {
      composedMessages.push({
        msgContent: { type: "text", text },
      });
    }
    return composedMessages;
  }

  const maxBytes = resolveSimplexMediaMaxBytes({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  for (let i = 0; i < mediaList.length; i += 1) {
    const mediaUrl = mediaList[i];
    if (!mediaUrl) {
      continue;
    }
    const resolved = await resolveMediaPath({ mediaUrl, maxBytes });
    const caption = i === 0 ? text : "";
    const msgContent = buildMediaMsgContent({
      text: caption,
      mediaPath: resolved.path,
      contentType: resolved.contentType,
      fileName: resolved.fileName,
      audioAsVoice: params.audioAsVoice,
    });
    composedMessages.push({
      fileSource: { filePath: resolved.path },
      msgContent,
    });
  }

  return composedMessages;
}
