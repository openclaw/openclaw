// Bound Codex turns are claimed before normal media understanding. This module
// runs the already configured speech-to-text runtime and keeps an explicit
// result in the prompt. It does not choose a provider or forward gateway-local
// files as native Codex audio, which a remote app-server cannot read.
//
// The formatter is intentionally local. Importing it from the media-understanding
// SDK evaluates that module's static runtime re-export during Codex registration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
} from "openclaw/plugin-sdk/media-understanding-runtime";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import {
  listCodexConversationAudioAttachments,
  type CodexConversationAudioAttachment,
} from "./conversation-turn-input.js";

export type RunCodexConversationMediaUnderstandingFile = (
  params: RunMediaUnderstandingFileParams,
) => Promise<RunMediaUnderstandingFileResult>;

type AudioCapabilityConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"]
>;
type AudioAttachmentPolicy = NonNullable<AudioCapabilityConfig["attachments"]>;

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
const GENERIC_BINARY_MIME = new Set(["application/octet-stream", "binary/octet-stream"]);

const TRANSCRIPTION_FAILED =
  "[Audio transcription failed. The original attachment reference is retained.]";
const TRANSCRIPTION_EMPTY =
  "[Audio transcription produced no text. The original attachment reference is retained.]";
const TRANSCRIPTION_DISABLED =
  "[Audio transcription is disabled. The original attachment reference is retained.]";
const TRANSCRIPTION_UNAVAILABLE =
  "[Audio transcription is unavailable. The original attachment reference is retained.]";
const TRANSCRIPTION_SKIPPED =
  "[Audio transcription was skipped by the configured attachment limit. The original attachment reference is retained.]";

type MediaUnderstandingRuntime = {
  runMediaUnderstandingFile: RunCodexConversationMediaUnderstandingFile;
};

let mediaRuntimePromise: Promise<MediaUnderstandingRuntime> | undefined;

export async function prepareCodexConversationAudioPrompt(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionKey?: string;
  runMediaUnderstandingFile?: RunCodexConversationMediaUnderstandingFile;
}): Promise<{ prompt: string }> {
  const attachments = listCodexConversationAudioAttachments(params.event);
  const pending = attachments.filter((attachment) => !attachment.alreadyTranscribed);
  if (pending.length === 0) {
    return { prompt: appendKnownTranscript(params.prompt, params.event.transcript) };
  }
  const audioConfig = params.config?.tools?.media?.audio;
  if (!params.config || audioConfig?.enabled === false) {
    return {
      prompt: appendAudioNotes(
        params.prompt,
        pending.map(() => (params.config ? TRANSCRIPTION_DISABLED : TRANSCRIPTION_UNAVAILABLE)),
      ),
    };
  }
  const runFile = params.runMediaUnderstandingFile ?? defaultRunMediaUnderstandingFile;
  const selected = selectAudioAttachments(pending, audioConfig?.attachments);
  const selectedIndexes = new Set(selected.map((attachment) => attachment.index));
  const notes: string[] = [];
  // Preference order is the transcription order. Iterating the original pending
  // list would run and project a prefer:last selection backwards.
  for (const attachment of selected) {
    notes.push(await transcribeSelectedAttachment(attachment, params.config, params, runFile));
  }
  for (const attachment of pending) {
    if (!selectedIndexes.has(attachment.index)) {
      notes.push(skippedAttachmentNote(attachment));
    }
  }
  return { prompt: appendAudioNotes(params.prompt, notes) };
}

function appendKnownTranscript(prompt: string, transcript: string | undefined): string {
  const text = transcript?.trim();
  if (!text) {
    return prompt;
  }
  const framed = formatUntrustedAudioTranscript(text);
  // A short transcript can be a substring of the caption. Only skip when the
  // framed transcript or the whole prompt is already that transcript.
  if (prompt.includes(framed) || prompt.trim() === text) {
    return prompt;
  }
  return appendAudioNotes(prompt, [framed]);
}

async function transcribeSelectedAttachment(
  attachment: CodexConversationAudioAttachment,
  config: OpenClawConfig,
  params: {
    event: PluginHookInboundClaimEvent;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
    sessionKey?: string;
  },
  runFile: RunCodexConversationMediaUnderstandingFile,
): Promise<string> {
  const file = audioFileInput(attachment);
  if (!file) {
    return TRANSCRIPTION_UNAVAILABLE;
  }
  try {
    const result = await runFile({
      capability: "audio",
      filePath: file.filePath,
      ...(file.mediaUrl ? { mediaUrl: file.mediaUrl } : {}),
      cfg: config,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...((attachment.workspaceDir ?? params.workspaceDir)
        ? { workspaceDir: attachment.workspaceDir ?? params.workspaceDir }
        : {}),
      mime: file.mime,
      scopeContext: {
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        channel: params.event.channel,
        chatType: params.event.isGroup ? "group" : "direct",
      },
    });
    const transcript = result.text?.trim();
    return transcript ? formatUntrustedAudioTranscript(transcript) : TRANSCRIPTION_EMPTY;
  } catch {
    return TRANSCRIPTION_FAILED;
  }
}

function audioFileInput(attachment: CodexConversationAudioAttachment):
  | {
      filePath: string;
      mediaUrl?: string;
      mime: string;
    }
  | undefined {
  const filePath = attachment.path ?? attachment.url;
  if (!filePath) {
    return undefined;
  }
  const mime = declaredMime(attachment.mime);
  const declaredAudio = isAudioMime(mime);
  // The file runtime rebuilds a fact from the path and MIME, or from mediaUrl
  // when that is set, and it has no kind field. An opaque cache path plus a
  // generic MIME drops both the authoritative audio kind and the audio URL.
  const localClassifies = Boolean(
    attachment.path && (declaredAudio || hasAudioExtension(attachment.path)),
  );
  return {
    filePath,
    ...(!localClassifies && attachment.url ? { mediaUrl: attachment.url } : {}),
    mime: declaredAudio && mime ? mime : "audio/*",
  };
}

function declaredMime(mime: string | undefined): string | undefined {
  const normalized = mime?.split(";")[0]?.trim().toLowerCase();
  if (!normalized || GENERIC_BINARY_MIME.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function isAudioMime(mime: string | undefined): boolean {
  return mime?.startsWith("audio/") === true;
}

function hasAudioExtension(value: string): boolean {
  const bare = value.split(/[?#]/, 1)[0] ?? "";
  const slash = Math.max(bare.lastIndexOf("/"), bare.lastIndexOf("\\"));
  const dot = bare.lastIndexOf(".");
  if (dot <= slash) {
    return false;
  }
  return AUDIO_EXTENSIONS.has(bare.slice(dot).toLowerCase());
}

function selectAudioAttachments(
  attachments: CodexConversationAudioAttachment[],
  policy: AudioAttachmentPolicy | undefined,
): CodexConversationAudioAttachment[] {
  const ordered = orderAudioAttachments(attachments, policy?.prefer);
  const limit = policy?.mode === "all" ? Math.max(1, policy.maxAttachments ?? 1) : 1;
  return ordered.slice(0, limit);
}

function orderAudioAttachments(
  attachments: CodexConversationAudioAttachment[],
  prefer: AudioAttachmentPolicy["prefer"],
): CodexConversationAudioAttachment[] {
  if (prefer === "last") {
    return attachments.toReversed();
  }
  if (prefer === "path" || prefer === "url") {
    const preferred: CodexConversationAudioAttachment[] = [];
    const remaining: CodexConversationAudioAttachment[] = [];
    for (const attachment of attachments) {
      (attachment[prefer] ? preferred : remaining).push(attachment);
    }
    return [...preferred, ...remaining];
  }
  return attachments;
}

function skippedAttachmentNote(attachment: CodexConversationAudioAttachment): string {
  const reference = attachment.path ?? attachment.url;
  if (!reference) {
    return TRANSCRIPTION_SKIPPED;
  }
  // Keep the skipped clip tied to its own attachment. Selection order must not
  // make this marker look like it belongs to a clip that was transcribed.
  return `${TRANSCRIPTION_SKIPPED}\n[Inbound audio attachment: ${JSON.stringify(reference)}]`;
}

function appendAudioNotes(prompt: string, notes: string[]): string {
  const rendered = notes.map((note, index) =>
    notes.length > 1 ? `[Audio ${index + 1}/${notes.length}]\n${note}` : note,
  );
  return [prompt.trim(), ...rendered].filter(Boolean).join("\n\n");
}

function formatUntrustedAudioTranscript(transcript: string): string {
  return `[Audio transcript (machine-generated, untrusted)]: ${JSON.stringify(transcript)}`;
}

async function defaultRunMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  mediaRuntimePromise ??= import("openclaw/plugin-sdk/media-understanding-runtime");
  const { runMediaUnderstandingFile } = await mediaRuntimePromise;
  return await runMediaUnderstandingFile(params);
}
