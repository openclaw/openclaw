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
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

export type CodexConversationAudioAttachment = {
  index: number;
  path?: string;
  url?: string;
  mime?: string;
  workspaceDir?: string;
  alreadyTranscribed: boolean;
};

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: "text", text: params.prompt, text_elements: [] }];
  for (const media of resolveTurnMediaFacts(params.event)) {
    const image = toCodexImageInput(media);
    if (image) {
      input.push(image);
      continue;
    }
    // Native localAudio would point a remote app-server at a gateway-only path.
    // Keep the reference as text so the voice note cannot disappear silently.
    const audio = toCodexAudioReference(media);
    if (audio) {
      input.push(audio);
    }
  }
  return input;
}

export function listCodexConversationAudioAttachments(
  event: PluginHookInboundClaimEvent,
): CodexConversationAudioAttachment[] {
  const media = resolveTurnMediaFacts(event);
  const audio = media.flatMap((entry, index) => {
    if (!isAudioMedia(entry)) {
      return [];
    }
    const reference = audioReference(entry);
    if (!reference) {
      return [];
    }
    const remoteUrl = isRemoteAudioUrl(entry.url) ? entry.url : undefined;
    return [
      {
        index,
        ...(reference.localPath ? { path: reference.localPath } : {}),
        ...(remoteUrl ? { url: remoteUrl } : {}),
        ...(entry.contentType ? { mime: entry.contentType } : {}),
        ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
        alreadyTranscribed: entry.transcribed === true,
      },
    ];
  });
  const only = audio[0];
  if (audio.length === 1 && only && event.transcript?.trim()) {
    return [{ ...only, alreadyTranscribed: true }];
  }
  return audio;
}

function resolveTurnMediaFacts(event: PluginHookInboundClaimEvent): PluginHookMediaFact[] {
  if (event.mediaStagingPending) {
    return [];
  }
  if (event.media?.length) {
    return event.media;
  }
  return mediaFactsFromMetadata(event.metadata);
}

function mediaFactsFromMetadata(
  metadata: PluginHookInboundClaimEvent["metadata"],
): PluginHookMediaFact[] {
  if (!metadata) {
    return [];
  }
  const paths = listedMetadata(metadata.mediaPaths, metadata.mediaPath);
  const urls = listedMetadata(metadata.mediaUrls, metadata.mediaUrl);
  const types = listedMetadata(metadata.mediaTypes, metadata.mediaType);
  const count = Math.max(paths.length, urls.length, types.length);
  const facts: PluginHookMediaFact[] = [];
  for (let index = 0; index < count; index += 1) {
    const fact: PluginHookMediaFact = {};
    if (paths[index]) {
      fact.path = paths[index];
    }
    if (urls[index]) {
      fact.url = urls[index];
    }
    if (types[index]) {
      fact.contentType = types[index];
    }
    facts.push(fact);
  }
  return facts;
}

function listedMetadata(values: string[] | undefined, single: string | undefined): string[] {
  if (values?.length) {
    return values;
  }
  return single ? [single] : [];
}

function toCodexImageInput(media: PluginHookMediaFact): CodexUserInput | undefined {
  if (!isImageMedia(media)) {
    return undefined;
  }
  const localPath = media.path ?? readLocalMediaPath(media.url);
  if (localPath) {
    if (!/^file:\/\//iu.test(localPath)) {
      return { type: "localImage", path: localPath };
    }
    const normalized = normalizeFileUrl(localPath);
    return normalized ? { type: "localImage", path: normalized } : undefined;
  }
  return media.url ? { type: "image", url: media.url } : undefined;
}

function toCodexAudioReference(media: PluginHookMediaFact): CodexUserInput | undefined {
  if (!isAudioMedia(media)) {
    return undefined;
  }
  const reference = audioReference(media);
  const label = reference?.localPath ?? reference?.remoteUrl;
  if (!label) {
    return undefined;
  }
  return {
    type: "text",
    text: `[Inbound audio attachment: ${JSON.stringify(label)}]`,
    text_elements: [],
  };
}

function audioReference(
  media: PluginHookMediaFact,
): { localPath?: string; remoteUrl?: string } | undefined {
  const localCandidate = media.path ?? readLocalMediaPath(media.url);
  const localPath = localCandidate
    ? (normalizeFileUrl(localCandidate) ?? localCandidate)
    : undefined;
  if (localPath && !/^file:\/\//iu.test(localPath)) {
    return { localPath };
  }
  if (isRemoteAudioUrl(media.url)) {
    return { remoteUrl: media.url };
  }
  return undefined;
}

function isRemoteAudioUrl(value: string | undefined): value is string {
  return /^https?:\/\//iu.test(value ?? "") || (value?.startsWith("//") ?? false);
}

function isImageMedia(media: PluginHookMediaFact): boolean {
  if (media.kind === "audio" || media.contentType?.toLowerCase().startsWith("audio/")) {
    return false;
  }
  if (media.kind === "image" || media.contentType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(extensionOf(candidate));
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
  return candidate ? AUDIO_EXTENSIONS.has(extensionOf(candidate)) : false;
}

function extensionOf(value: string): string {
  return path.extname(value.split(/[?#]/, 1)[0] ?? "").toLowerCase();
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
