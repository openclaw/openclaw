// Codex plugin module prepares bound-conversation audio for configured transcription.
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

type RunMediaUnderstandingFile = (
  params: RunMediaUnderstandingFileParams,
) => Promise<RunMediaUnderstandingFileResult>;

type AudioAttachmentPolicy = {
  mode?: "first" | "all";
  maxAttachments?: number;
  prefer?: "first" | "last" | "path" | "url";
};

export type PreparedCodexConversationAudioPrompt = {
  prompt: string;
  audioInputAttachmentIndexes: readonly number[];
};

function selectCodexConversationAudioAttachments(params: {
  attachments: CodexConversationAudioAttachment[];
  policy?: AudioAttachmentPolicy;
}): CodexConversationAudioAttachment[] {
  const matches = params.attachments.filter((attachment) => !attachment.alreadyTranscribed);
  const preferred = params.policy?.prefer;
  const ordered =
    preferred === "last"
      ? matches.toReversed()
      : preferred === "path" || preferred === "url"
        ? [
            ...matches.filter((attachment) => attachment[preferred]),
            ...matches.filter((attachment) => !attachment[preferred]),
          ]
        : matches;
  const limit = params.policy?.mode === "all" ? Math.max(1, params.policy.maxAttachments ?? 1) : 1;
  return ordered.slice(0, limit);
}

function resolveAuthoritativeAudioMime(mime: string | undefined): string | undefined {
  const normalized = mime?.trim().toLowerCase();
  if (!normalized || (normalized !== "audio" && !normalized.startsWith("audio/"))) {
    return "audio/*";
  }
  return mime;
}

export async function prepareCodexConversationAudioPrompt(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionKey?: string;
  runMediaUnderstandingFile?: RunMediaUnderstandingFile;
}): Promise<PreparedCodexConversationAudioPrompt> {
  const audioAttachments = listCodexConversationAudioAttachments(params.event);
  if (audioAttachments.length === 0) {
    return { prompt: params.prompt, audioInputAttachmentIndexes: [] };
  }
  // Keep message-level selection in the plugin so independently distributed Codex builds
  // retain the existing runFile host contract across their declared compatibility window.
  const selectedAudio = selectCodexConversationAudioAttachments({
    attachments: audioAttachments,
    policy: params.config?.tools?.media?.audio?.attachments,
  });
  const audioInputAttachmentIndexes: number[] = [];
  const promptParts: Array<{ ordinal: number; text: string }> = [];
  if (!params.config || !params.runMediaUnderstandingFile) {
    for (const [selectedIndex, audio] of selectedAudio.entries()) {
      audioInputAttachmentIndexes.push(audio.index);
      promptParts.push({
        ordinal: selectedIndex + 1,
        text: "[Audio transcription is unavailable; the original attachment is included when supported.]",
      });
    }
    return {
      prompt: appendPreparedAudioPrompt(params.prompt, promptParts, selectedAudio.length),
      audioInputAttachmentIndexes,
    };
  }
  const { formatAudioTranscriptForAgent } =
    await import("openclaw/plugin-sdk/media-understanding-runtime");
  for (const [selectedIndex, audio] of selectedAudio.entries()) {
    const filePath = audio.path ?? audio.url;
    if (!filePath) {
      continue;
    }
    const mime = resolveAuthoritativeAudioMime(audio.mime);
    try {
      const result = await params.runMediaUnderstandingFile({
        capability: "audio",
        filePath,
        ...(!audio.path && audio.url ? { mediaUrl: audio.url } : {}),
        cfg: params.config,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.agentDir ? { agentDir: params.agentDir } : {}),
        ...((audio.workspaceDir ?? params.workspaceDir)
          ? { workspaceDir: audio.workspaceDir ?? params.workspaceDir }
          : {}),
        ...(mime ? { mime } : {}),
        scopeContext: {
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          channel: params.event.channel,
          chatType: params.event.isGroup ? "group" : "direct",
        },
      });
      const transcript = result.text?.trim();
      if (transcript) {
        promptParts.push({
          ordinal: selectedIndex + 1,
          text: formatAudioTranscriptForAgent(transcript),
        });
        continue;
      }
      promptParts.push({
        ordinal: selectedIndex + 1,
        text: "[Audio transcription produced no text; the original attachment is included when supported.]",
      });
    } catch {
      promptParts.push({
        ordinal: selectedIndex + 1,
        text: "[Audio transcription failed; the original attachment is included when supported.]",
      });
    }
    audioInputAttachmentIndexes.push(audio.index);
  }
  return {
    prompt: appendPreparedAudioPrompt(params.prompt, promptParts, selectedAudio.length),
    audioInputAttachmentIndexes,
  };
}

function appendPreparedAudioPrompt(
  prompt: string,
  parts: Array<{ ordinal: number; text: string }>,
  selectedCount: number,
): string {
  const rendered = parts.map((part) =>
    selectedCount > 1 ? `[Audio ${part.ordinal}/${selectedCount}]\n${part.text}` : part.text,
  );
  return [prompt, ...rendered].filter(Boolean).join("\n\n");
}
