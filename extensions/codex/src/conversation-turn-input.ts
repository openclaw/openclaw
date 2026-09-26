import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PluginHookInboundClaimEvent,
  PluginHookMediaFact,
} from "openclaw/plugin-sdk/plugin-entry";
import type { CodexUserInput } from "./app-server/protocol.js";

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);
const CODEX_LOCAL_AUDIO_EXTENSIONS = new Set([".m4a", ".mp3", ".ogg", ".wav", ".webm"]);
export type CodexConversationAudioAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  kind?: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
  workspaceDir?: string;
  index: number;
  alreadyTranscribed?: boolean;
};

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  audioInputAttachmentIndexes?: readonly number[];
}): CodexUserInput[] {
  const media = params.event.media ?? [];
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...media.map((entry) => toCodexMediaInput(entry, false)).filter(isCodexUserInput),
    ...(params.audioInputAttachmentIndexes ?? [])
      .map((index) => media[index])
      .filter((entry): entry is PluginHookMediaFact => entry !== undefined && isAudioMedia(entry))
      .map((entry) => toCodexMediaInput(entry, true))
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

export function hasCodexConversationTurnMedia(event: PluginHookInboundClaimEvent): boolean {
  return (event.media ?? []).some((media) => isImageMedia(media) || isAudioMedia(media));
}

export function hasUsableCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  audioInputAttachmentIndexes?: readonly number[];
}): boolean {
  return buildCodexConversationTurnInput(params).some(
    (input) => input.type !== "text" || Boolean(input.text.trim()),
  );
}

export function listCodexConversationAudioAttachments(
  event: PluginHookInboundClaimEvent,
): CodexConversationAudioAttachment[] {
  const media = event.media ?? [];
  const audioCount = media.filter(isAudioMedia).length;
  const transcriptCoversSingleAudio = audioCount === 1 && Boolean(event.transcript?.trim());
  return media.flatMap((entry, index) => {
    if (!isAudioMedia(entry)) {
      return [];
    }
    const localPath = entry.path ?? readLocalMediaPath(entry.url);
    const normalizedLocalPath = localPath ? normalizeFileUrl(localPath) : undefined;
    const remoteMediaUrl =
      entry.url && (/^https?:\/\//iu.test(entry.url) || /^data:audio\//iu.test(entry.url))
        ? entry.url
        : undefined;
    const filePath = normalizedLocalPath ?? remoteMediaUrl;
    if (!filePath) {
      return [];
    }
    return [
      {
        index,
        ...(normalizedLocalPath ? { path: normalizedLocalPath } : {}),
        ...(remoteMediaUrl ? { url: remoteMediaUrl } : {}),
        ...(entry.contentType ? { mime: entry.contentType } : {}),
        kind: "audio" as const,
        ...(entry.transcribed === true || transcriptCoversSingleAudio
          ? { alreadyTranscribed: true }
          : {}),
        ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
      },
    ];
  });
}

function isCodexUserInput(item: CodexUserInput | undefined): item is CodexUserInput {
  return item !== undefined;
}

function toCodexMediaInput(
  media: PluginHookMediaFact,
  includeAudio: boolean,
): CodexUserInput | undefined {
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    const normalized = normalizeFileUrl(localPath);
    if (!normalized) {
      return undefined;
    }
    if (isImageMedia(media)) {
      return { type: "localImage", path: normalized };
    }
    if (includeAudio && isAudioMedia(media) && isCodexLocalAudioPath(normalized)) {
      return { type: "localAudio", path: normalized };
    }
    if (includeAudio && isAudioMedia(media) && isDataAudioUrl(media.url)) {
      return { type: "audio", url: media.url };
    }
    return undefined;
  }
  if (isImageMedia(media)) {
    return media.url ? { type: "image", url: media.url } : undefined;
  }
  if (includeAudio && isAudioMedia(media) && isDataAudioUrl(media.url)) {
    return { type: "audio", url: media.url };
  }
  return undefined;
}

function isImageMedia(media: PluginHookMediaFact): boolean {
  const kind = media.kind?.trim().toLowerCase();
  if (kind && kind !== "unknown") {
    if (kind === "image") {
      return true;
    }
    if (kind !== "sticker") {
      return false;
    }
  }
  const mimeType = media.contentType?.trim().toLowerCase();
  if (mimeType) {
    if (mimeType.startsWith("image/")) {
      return true;
    }
    if (mimeType !== "application/octet-stream" && mimeType !== "binary/octet-stream") {
      return false;
    }
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function isAudioMedia(media: PluginHookMediaFact): boolean {
  const kind = media.kind?.trim().toLowerCase();
  if (kind && kind !== "unknown") {
    return kind === "audio";
  }
  const mimeType = media.contentType?.trim().toLowerCase();
  if (mimeType === "audio" || mimeType?.startsWith("audio/")) {
    return true;
  }
  if (mimeType && mimeType !== "application/octet-stream" && mimeType !== "binary/octet-stream") {
    return false;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return AUDIO_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function isCodexLocalAudioPath(value: string): boolean {
  return CODEX_LOCAL_AUDIO_EXTENSIONS.has(path.extname(value).toLowerCase());
}

function isDataAudioUrl(value: string | undefined): value is string {
  return value?.toLowerCase().startsWith("data:audio/") === true;
}

function normalizeFileUrl(value: string): string | undefined {
  if (!/^file:\/\//iu.test(value)) {
    return value;
  }
  try {
    const fileUrl = new URL(value);
    // Validate encoding explicitly because fileURLToPath validation differs by runtime.
    decodeURIComponent(fileUrl.pathname);
    return fileURLToPath(fileUrl);
  } catch {
    return undefined;
  }
}

function readLocalMediaPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/^file:\/\//iu.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return undefined;
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? undefined : value;
}
