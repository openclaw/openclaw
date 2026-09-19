import {
  formatInboundMediaUnavailableText,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import type { IMessageAttachment } from "./types.js";

export function isIMessagePluginPayloadAttachment(attachment: {
  original_path?: string | null;
  transfer_name?: string | null;
  uti?: string | null;
}): boolean {
  const attachmentPath = attachment.original_path?.trim().toLowerCase() ?? "";
  const transferName = attachment.transfer_name?.trim().toLowerCase() ?? "";
  const uti = attachment.uti?.trim().toLowerCase() ?? "";
  return (
    attachmentPath.endsWith(".pluginpayloadattachment") ||
    transferName.endsWith(".pluginpayloadattachment") ||
    uti === "com.apple.messages.pluginpayloadattachment"
  );
}

export function resolveIMessageInboundMediaInput(params: {
  messageText: string;
  attachments: IMessageAttachment[];
  effectiveAttachmentRoots: readonly string[];
  logVerbose?: (message: string) => void;
}) {
  // Apple rich-link previews are opaque plugin payloads; the useful URL stays
  // in message text. Treating them as media creates phantom attachments and
  // incorrectly bypasses text-only inbound debounce.
  const mediaCandidates = params.attachments.filter(
    (entry) => !isIMessagePluginPayloadAttachment(entry),
  );
  const mediaFacts = mediaCandidates.map((attachment): ChannelInboundMediaInput => {
    const contentType = attachment.mime_type?.trim() || undefined;
    return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
  });
  const rawMediaAttachments = mediaCandidates.map((attachment, index) => {
    const fact = mediaFacts[index] ?? { kind: "unknown" as const };
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      return fact;
    }
    if (
      !isInboundPathAllowed({ filePath: attachmentPath, roots: params.effectiveAttachmentRoots })
    ) {
      params.logVerbose?.(
        `imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`,
      );
      return fact;
    }
    return { ...fact, path: attachmentPath };
  });
  return {
    bodyText: params.messageText,
    mediaFacts,
    mediaCandidates,
    rawMediaAttachments,
  };
}

export function formatIMessageInboundMediaBody(params: {
  messageText: string;
  unavailableCount: number;
}): string {
  return formatInboundMediaUnavailableText({
    body: params.messageText,
    notice: `[imessage ${params.unavailableCount > 1 ? `${params.unavailableCount} attachments` : "attachment"} unavailable]`,
  });
}
