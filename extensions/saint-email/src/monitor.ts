import type { RuntimeEnv } from "openclaw/plugin-sdk";
import type {
  CoreConfig,
  GmailMessage,
  GmailMessageHeader,
  GmailMessagePart,
  ResolvedSaintEmailAccount,
  SaintEmailInboundMessage,
} from "./types.js";
import {
  decodeBase64Url,
  decodeBase64UrlToBuffer,
  gmailGetAttachment,
  gmailGetMessage,
  gmailListMessages,
} from "./gmail-api.js";
import { handleSaintEmailInbound } from "./inbound.js";
import {
  getSaintEmailRuntime,
  registerSaintEmailMonitor,
  unregisterSaintEmailMonitor,
} from "./runtime.js";

type InboundAttachmentCandidate = {
  filename: string;
  mimeType?: string;
  size?: number;
  attachmentId?: string;
  inlineData?: string;
};

function headerValue(headers: GmailMessageHeader[] | undefined, name: string): string {
  const lowered = name.toLowerCase();
  return headers?.find((entry) => entry?.name?.toLowerCase() === lowered)?.value?.trim() ?? "";
}

function extractEmailAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  if (angle?.[1]) {
    return angle[1].trim().toLowerCase();
  }
  return value.trim().toLowerCase();
}

function stripHtml(html: string): string {
  // Strip <script> and <style> blocks (and their content) first
  let stripped = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  stripped = stripped.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // Strip remaining HTML tags
  stripped = stripped.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  stripped = stripped
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  return stripped.replace(/\s+/g, " ").trim();
}

function decodePartText(part?: GmailMessagePart): string {
  if (!part) {
    return "";
  }
  const mimeType = part.mimeType?.toLowerCase();
  const bodyData = part.body?.data;

  // For multipart/alternative, prefer text/plain over text/html
  if (mimeType === "multipart/alternative" && part.parts?.length) {
    const plainPart = part.parts.find((p) => p.mimeType?.toLowerCase() === "text/plain");
    if (plainPart) {
      const decoded = decodePartText(plainPart);
      if (decoded.trim()) {
        return decoded;
      }
    }
    // Fall through to try other parts
  }

  if (bodyData && (mimeType === "text/plain" || mimeType === "text/html" || !mimeType)) {
    const decoded = decodeBase64Url(bodyData);
    return mimeType === "text/html" ? stripHtml(decoded) : decoded;
  }
  for (const child of part.parts ?? []) {
    const decoded = decodePartText(child);
    if (decoded.trim()) {
      return decoded;
    }
  }
  return "";
}

function sanitizeAttachmentFilename(filename: string, index: number): string {
  const trimmed = filename.trim();
  if (!trimmed) {
    return `attachment-${index + 1}.bin`;
  }
  const cleaned = trimmed.replace(/[/\\]/g, "_");
  return cleaned || `attachment-${index + 1}.bin`;
}

function collectAttachmentCandidates(
  part: GmailMessagePart | undefined,
  out: InboundAttachmentCandidate[] = [],
): InboundAttachmentCandidate[] {
  if (!part) {
    return out;
  }
  const filename = typeof part.filename === "string" ? part.filename.trim() : "";
  const attachmentId =
    typeof part.body?.attachmentId === "string" ? part.body.attachmentId.trim() : "";
  const inlineData = typeof part.body?.data === "string" ? part.body.data.trim() : "";
  if (attachmentId || (filename && inlineData)) {
    out.push({
      filename,
      mimeType: part.mimeType?.trim(),
      size: part.body?.size,
      attachmentId: attachmentId || undefined,
      inlineData: inlineData || undefined,
    });
  }
  for (const child of part.parts ?? []) {
    collectAttachmentCandidates(child, out);
  }
  return out;
}

async function resolveInboundAttachments(params: {
  account: ResolvedSaintEmailAccount;
  messageId: string;
  payload: GmailMessagePart | undefined;
}): Promise<Array<{ path: string; filename: string; mimeType?: string }>> {
  const core = getSaintEmailRuntime();
  const candidates = collectAttachmentCandidates(params.payload);
  if (candidates.length === 0) {
    return [];
  }
  const maxBytes = Math.max(1, params.account.maxAttachmentMb) * 1024 * 1024;
  const out: Array<{ path: string; filename: string; mimeType?: string }> = [];
  for (const [index, candidate] of candidates.entries()) {
    if (typeof candidate.size === "number" && candidate.size > maxBytes) {
      continue;
    }
    try {
      let buffer: Buffer;
      if (candidate.inlineData) {
        buffer = decodeBase64UrlToBuffer(candidate.inlineData);
      } else if (candidate.attachmentId) {
        buffer = await gmailGetAttachment({
          account: params.account,
          messageId: params.messageId,
          attachmentId: candidate.attachmentId,
        });
      } else {
        continue;
      }
      if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) {
        continue;
      }
      const filename = sanitizeAttachmentFilename(candidate.filename, index);
      const saved = await core.channel.media.saveMediaBuffer(
        buffer,
        candidate.mimeType,
        "inbound",
        maxBytes,
        filename,
      );
      out.push({
        path: saved.path,
        filename,
        mimeType: saved.contentType ?? candidate.mimeType,
      });
    } catch {
      // Keep polling resilient: one failed attachment should not drop the message.
      continue;
    }
  }
  return out;
}

function toInboundMessage(params: {
  message: GmailMessage;
  attachments: Array<{ path: string; filename: string; mimeType?: string }>;
}): SaintEmailInboundMessage | null {
  const { message, attachments } = params;
  const headers = message.payload?.headers;
  const from = headerValue(headers, "From");
  const to = headerValue(headers, "To");
  const subject = headerValue(headers, "Subject") || "(no subject)";
  const fromEmail = extractEmailAddress(from);
  if (!fromEmail) {
    return null;
  }
  const text = decodePartText(message.payload) || (message.snippet ?? "");
  const timestamp = Number.parseInt(message.internalDate ?? "0", 10);

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    from: from || fromEmail,
    fromEmail,
    to,
    text: text.trim(),
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
    attachments,
  };
}

export type SaintEmailMonitorOptions = {
  account: ResolvedSaintEmailAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export async function monitorSaintEmailProvider(
  opts: SaintEmailMonitorOptions,
): Promise<{ stop: () => void }> {
  const core = getSaintEmailRuntime();
  const logger = core.logging.getChildLogger({
    channel: "email",
    accountId: opts.account.accountId,
  });
  const MAX_SEEN = 10_000;
  const seen = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let pendingWake = false;

  const pollOnce = async () => {
    if (running) {
      // Mark that a wake arrived while we were busy, so we re-poll after current completes
      pendingWake = true;
      return;
    }
    running = true;
    pendingWake = false;
    try {
      const ids = await gmailListMessages({
        account: opts.account,
        query: opts.account.pollQuery,
        maxResults: opts.account.maxPollResults,
      });

      for (const id of ids) {
        if (seen.has(id)) {
          continue;
        }
        // Process each message individually — don't let one failure abort the batch
        try {
          const message = await gmailGetMessage({ account: opts.account, id });
          const attachments = await resolveInboundAttachments({
            account: opts.account,
            messageId: message.id,
            payload: message.payload,
          });
          const inbound = toInboundMessage({
            message,
            attachments,
          });
          if (!inbound || (!inbound.text && inbound.attachments.length === 0)) {
            // Mark as seen even if we can't parse it (it's not a transient failure)
            seen.add(id);
            continue;
          }
          await handleSaintEmailInbound({
            message: inbound,
            account: opts.account,
            config: opts.config,
            runtime: opts.runtime,
            statusSink: opts.statusSink,
          });
          // Only mark as seen AFTER successful processing
          seen.add(id);
        } catch (msgErr) {
          // Don't add to seen — will be retried on next poll
          logger.warn(`[email] failed to process message ${id}: ${String(msgErr)}`);
        }
      }

      // Evict oldest entries after the batch to prevent unbounded growth
      while (seen.size > MAX_SEEN) {
        seen.delete(seen.values().next().value!);
      }
    } catch (err) {
      logger.warn(`[email] poll failed: ${String(err)}`);
    } finally {
      running = false;
      // If a wake arrived during polling, re-poll to pick up new messages
      if (pendingWake) {
        pendingWake = false;
        void pollOnce();
      }
    }
  };

  registerSaintEmailMonitor(opts.account.accountId, () => {
    void pollOnce();
  });

  timer = setInterval(
    () => {
      void pollOnce();
    },
    Math.max(5, opts.account.pollIntervalSec) * 1000,
  );
  timer.unref?.();

  void pollOnce();

  const stop = () => {
    unregisterSaintEmailMonitor(opts.account.accountId);
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Remove abort listener to prevent reference leaks
    if (opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", stop);
    }
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", stop, { once: true });
  }

  return { stop };
}

export const __testing = {
  toInboundMessage,
  decodePartText,
  extractEmailAddress,
  stripHtml,
  collectAttachmentCandidates,
  sanitizeAttachmentFilename,
};
