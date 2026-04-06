import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

type DiscordAudioAttachment = {
  content_type?: string;
  url?: string;
};

type IndexedDiscordAudioAttachment = DiscordAudioAttachment & {
  attachmentIndex: number;
};

function collectAudioAttachments(
  attachments: DiscordAudioAttachment[] | undefined,
): IndexedDiscordAudioAttachment[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments.flatMap((att, attachmentIndex) =>
    att.content_type?.startsWith("audio/") ? [{ ...att, attachmentIndex }] : [],
  );
}

export async function resolveDiscordPreflightAudioMentionContext(params: {
  message: {
    attachments?: DiscordAudioAttachment[];
    content?: string;
  };
  chatType: "direct" | "group" | "channel";
  sessionKey?: string;
  shouldRequireMention: boolean;
  mentionRegexes: RegExp[];
  cfg: OpenClawConfig;
  abortSignal?: AbortSignal;
}): Promise<{
  hasAudioAttachment: boolean;
  hasTypedText: boolean;
  transcript?: string;
  transcribedAttachmentIndex?: number;
}> {
  const audioAttachments = collectAudioAttachments(params.message.attachments);
  const hasAudioAttachment = audioAttachments.length > 0;
  const hasTypedText = Boolean(params.message.content?.trim());
  const needsPreflightTranscription =
    hasAudioAttachment &&
    // `baseText` includes media placeholders; gate on typed text only.
    !hasTypedText &&
    (params.chatType === "direct" ||
      (params.shouldRequireMention && params.mentionRegexes.length > 0));

  let transcript: string | undefined;
  let transcribedAttachmentIndex: number | undefined;
  if (needsPreflightTranscription) {
    if (params.abortSignal?.aborted) {
      return {
        hasAudioAttachment,
        hasTypedText,
      };
    }
    try {
      const { transcribeFirstAudioResult } = await import("./preflight-audio.runtime.js");
      if (params.abortSignal?.aborted) {
        return {
          hasAudioAttachment,
          hasTypedText,
        };
      }
      const transcriptionCandidates = audioAttachments.filter(
        (att): att is IndexedDiscordAudioAttachment & { url: string } =>
          typeof att.url === "string" && att.url.length > 0,
      );
      if (transcriptionCandidates.length > 0) {
        const result = await transcribeFirstAudioResult({
          ctx: {
            MediaUrls: transcriptionCandidates.map((att) => att.url),
            MediaTypes: transcriptionCandidates
              .map((att) => att.content_type)
              .filter((contentType): contentType is string => Boolean(contentType)),
            ChatType: params.chatType,
            SessionKey: params.sessionKey,
            Surface: "discord",
            Provider: "discord",
          },
          cfg: params.cfg,
          agentDir: undefined,
        });
        transcript = result.transcript;
        if (params.abortSignal?.aborted) {
          transcript = undefined;
        } else {
          transcribedAttachmentIndex = result.attachmentIndex;
        }
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }

  return {
    hasAudioAttachment,
    hasTypedText,
    transcript,
    transcribedAttachmentIndex,
  };
}
