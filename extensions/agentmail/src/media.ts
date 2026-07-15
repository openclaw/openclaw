import { basename } from "node:path";
import type { AgentMail, AgentMailClient } from "agentmail";
import { normalizeMimeType } from "openclaw/plugin-sdk/media-mime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import {
  loadOutboundMediaFromUrl,
  type OutboundMediaLoadOptions,
} from "openclaw/plugin-sdk/outbound-media";
import { MediaFetchError, loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";

export type AgentMailInboundMedia = {
  paths: string[];
  types: string[];
};

export class AgentMailMediaPolicyError extends Error {}

function sanitizeFilename(value: string | undefined, fallback: string): string {
  let printable = "";
  for (const character of value ?? "") {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) {
      printable += character;
    }
  }
  const clean = basename(printable).trim();
  return clean || fallback;
}

function isAcceptedAttachment(attachment: AgentMail.Attachment): boolean {
  return attachment.contentDisposition !== "inline" && !attachment.contentId;
}

export async function loadAgentMailInboundAttachments(params: {
  client: AgentMailClient;
  inboxId: string;
  messageId: string;
  attachments: readonly AgentMail.Attachment[];
  maxBytes: number;
}): Promise<AgentMailInboundMedia> {
  const accepted = params.attachments.filter(isAcceptedAttachment);
  let declaredBytes = 0;
  for (const attachment of accepted) {
    if (attachment.size > params.maxBytes) {
      throw new AgentMailMediaPolicyError(
        "AgentMail attachment exceeds the configured per-file media limit",
      );
    }
    declaredBytes += attachment.size;
    if (declaredBytes > params.maxBytes) {
      throw new AgentMailMediaPolicyError(
        "AgentMail attachments exceed the configured aggregate media limit",
      );
    }
  }

  // Download every part before persisting any of them so a failed signed URL never
  // dispatches a partial attachment set to the agent.
  const downloaded: Array<{
    buffer: Buffer;
    contentType?: string;
    filename: string;
  }> = [];
  let actualBytes = 0;
  for (const attachment of accepted) {
    const metadata = await params.client.inboxes.messages.getAttachment(
      params.inboxId,
      params.messageId,
      attachment.attachmentId,
    );
    const remaining = params.maxBytes - actualBytes;
    let loaded;
    try {
      loaded = await loadWebMediaRaw(metadata.downloadUrl, { maxBytes: remaining });
    } catch (error) {
      if (error instanceof MediaFetchError && error.code === "max_bytes") {
        throw new AgentMailMediaPolicyError(
          "AgentMail attachment exceeds the configured media limit",
          { cause: error },
        );
      }
      throw error;
    }
    actualBytes += loaded.buffer.byteLength;
    if (actualBytes > params.maxBytes) {
      throw new AgentMailMediaPolicyError(
        "AgentMail attachments exceed the configured aggregate media limit",
      );
    }
    downloaded.push({
      buffer: loaded.buffer,
      contentType:
        normalizeMimeType(metadata.contentType ?? loaded.contentType) ?? "application/octet-stream",
      filename: sanitizeFilename(metadata.filename, `attachment-${attachment.attachmentId}`),
    });
  }

  const saved = await Promise.all(
    downloaded.map(
      async (attachment) =>
        await saveMediaBuffer(
          attachment.buffer,
          attachment.contentType,
          "inbound",
          params.maxBytes,
          attachment.filename,
        ),
    ),
  );
  return {
    paths: saved.map((item) => item.path),
    types: saved.map((item) => item.contentType ?? "application/octet-stream"),
  };
}

export async function loadAgentMailOutboundAttachments(params: {
  mediaUrls: readonly string[];
  maxBytes: number;
  mediaAccess?: OutboundMediaLoadOptions["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
}): Promise<AgentMail.SendAttachment[]> {
  let totalBytes = 0;
  const attachments: AgentMail.SendAttachment[] = [];
  for (const [index, mediaUrl] of params.mediaUrls.entries()) {
    const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
      maxBytes: params.maxBytes - totalBytes,
      mediaAccess: params.mediaAccess,
      mediaLocalRoots: params.mediaLocalRoots,
      mediaReadFile: params.mediaReadFile,
    });
    totalBytes += loaded.buffer.byteLength;
    if (totalBytes > params.maxBytes) {
      throw new Error("AgentMail outbound attachments exceed the configured aggregate media limit");
    }
    attachments.push({
      filename: sanitizeFilename(loaded.fileName, `attachment-${index + 1}`),
      contentType: normalizeMimeType(loaded.contentType) ?? "application/octet-stream",
      contentDisposition: "attachment",
      content: loaded.buffer.toString("base64"),
    });
  }
  return attachments;
}
