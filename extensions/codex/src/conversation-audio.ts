// Bound Codex turns are claimed before normal media understanding. This module
// runs the already configured speech-to-text runtime and keeps an explicit
// result in the prompt. It does not choose a provider or forward gateway-local
// files as native Codex audio, which a remote app-server cannot read.
import {
  formatAudioTranscriptForAgent,
  type RunMediaUnderstandingFileParams,
  type RunMediaUnderstandingFileResult,
} from "openclaw/plugin-sdk/media-understanding-runtime";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import {
  listCodexConversationAudioAttachments,
  type CodexConversationAudioAttachment,
} from "./conversation-turn-input.js";

export type RunCodexConversationMediaUnderstandingFile = (
  params: RunMediaUnderstandingFileParams,
) => Promise<RunMediaUnderstandingFileResult>;

type AudioAttachmentPolicy = {
  mode?: "first" | "all";
  maxAttachments?: number;
  prefer?: "first" | "last" | "path" | "url";
};

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

export async function prepareCodexConversationAudioPrompt(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  config?: unknown;
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
  const audioConfig = readAudioUnderstandingConfig(params.config);
  if (!params.config || audioConfig.enabled === false) {
    return {
      prompt: appendAudioNotes(
        params.prompt,
        pending.map(() => (params.config ? TRANSCRIPTION_DISABLED : TRANSCRIPTION_UNAVAILABLE)),
      ),
    };
  }
  const runFile = params.runMediaUnderstandingFile ?? defaultRunMediaUnderstandingFile;
  const selected = selectAudioAttachments(pending, audioConfig.attachments);
  const selectedIndexes = new Set(selected.map((attachment) => attachment.index));
  const notes: string[] = [];
  for (const attachment of pending) {
    notes.push(
      selectedIndexes.has(attachment.index)
        ? await transcribeSelectedAttachment(attachment, params, runFile)
        : TRANSCRIPTION_SKIPPED,
    );
  }
  return { prompt: appendAudioNotes(params.prompt, notes) };
}

function appendKnownTranscript(prompt: string, transcript: string | undefined): string {
  const text = transcript?.trim();
  if (!text) {
    return prompt;
  }
  const framed = formatAudioTranscriptForAgent(text);
  // A short transcript can be a substring of the caption. Only skip when the
  // framed transcript or the whole prompt is already that transcript.
  if (prompt.includes(framed) || prompt.trim() === text) {
    return prompt;
  }
  return appendAudioNotes(prompt, [framed]);
}

async function transcribeSelectedAttachment(
  attachment: CodexConversationAudioAttachment,
  params: {
    event: PluginHookInboundClaimEvent;
    config?: unknown;
    agentId?: string;
    agentDir?: string;
    workspaceDir?: string;
    sessionKey?: string;
  },
  runFile: RunCodexConversationMediaUnderstandingFile,
): Promise<string> {
  const filePath = attachment.path ?? attachment.url;
  if (!filePath) {
    return TRANSCRIPTION_UNAVAILABLE;
  }
  try {
    const result = await runFile({
      capability: "audio",
      filePath,
      ...(!attachment.path && attachment.url ? { mediaUrl: attachment.url } : {}),
      cfg: params.config as RunMediaUnderstandingFileParams["cfg"],
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...((attachment.workspaceDir ?? params.workspaceDir)
        ? { workspaceDir: attachment.workspaceDir ?? params.workspaceDir }
        : {}),
      mime: attachment.mime ?? "audio/*",
      scopeContext: {
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        channel: params.event.channel,
        chatType: params.event.isGroup ? "group" : "direct",
      },
    });
    const transcript = result.text?.trim();
    return transcript ? formatAudioTranscriptForAgent(transcript) : TRANSCRIPTION_EMPTY;
  } catch {
    return TRANSCRIPTION_FAILED;
  }
}

function selectAudioAttachments(
  attachments: CodexConversationAudioAttachment[],
  policy: AudioAttachmentPolicy | undefined,
): CodexConversationAudioAttachment[] {
  const preferred = policy?.prefer;
  const ordered =
    preferred === "last"
      ? attachments.toReversed()
      : preferred === "path" || preferred === "url"
        ? [
            ...attachments.filter((attachment) => attachment[preferred]),
            ...attachments.filter((attachment) => !attachment[preferred]),
          ]
        : attachments;
  const limit = policy?.mode === "all" ? Math.max(1, policy.maxAttachments ?? 1) : 1;
  return ordered.slice(0, limit);
}

function readAudioUnderstandingConfig(config: unknown): {
  enabled?: boolean;
  attachments?: AudioAttachmentPolicy;
} {
  const tools = readRecord(readRecord(config)?.tools);
  const media = readRecord(tools?.media);
  const audio = readRecord(media?.audio);
  const attachments = readRecord(audio?.attachments);
  return {
    ...(typeof audio?.enabled === "boolean" ? { enabled: audio.enabled } : {}),
    ...(attachments ? { attachments: readAttachmentPolicy(attachments) } : {}),
  };
}

function readAttachmentPolicy(value: Record<string, unknown>): AudioAttachmentPolicy {
  const mode = value.mode === "all" || value.mode === "first" ? value.mode : undefined;
  const prefer =
    value.prefer === "first" ||
    value.prefer === "last" ||
    value.prefer === "path" ||
    value.prefer === "url"
      ? value.prefer
      : undefined;
  const maxAttachments =
    typeof value.maxAttachments === "number" && Number.isFinite(value.maxAttachments)
      ? value.maxAttachments
      : undefined;
  return {
    ...(mode ? { mode } : {}),
    ...(prefer ? { prefer } : {}),
    ...(maxAttachments !== undefined ? { maxAttachments } : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function appendAudioNotes(prompt: string, notes: string[]): string {
  const rendered = notes.map((note, index) =>
    notes.length > 1 ? `[Audio ${index + 1}/${notes.length}]\n${note}` : note,
  );
  return [prompt.trim(), ...rendered].filter(Boolean).join("\n\n");
}

async function defaultRunMediaUnderstandingFile(
  params: RunMediaUnderstandingFileParams,
): Promise<RunMediaUnderstandingFileResult> {
  const { runMediaUnderstandingFile } =
    await import("openclaw/plugin-sdk/media-understanding-runtime");
  return await runMediaUnderstandingFile(params);
}
