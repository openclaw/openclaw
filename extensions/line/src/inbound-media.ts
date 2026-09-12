// Line plugin module downloads the attachments of one inbound LINE send.
import type { webhook } from "@line/bot-sdk";
import type { ChannelInboundMediaInput } from "openclaw/plugin-sdk/channel-inbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { downloadLineMedia, isRetryableLineInboundMediaError } from "./download.js";
import type { ResolvedLineAccount } from "./types.js";
import type { LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";

type LineMessage = webhook.MessageEvent["message"];

type LineInboundMediaRef = Pick<ChannelInboundMediaInput, "contentType" | "fileName"> & {
  path: string;
};

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: LineMessage["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

/**
 * Downloads the attachments of one LINE send, in the order the sender picked
 * them: a single message, or every part of a multi-image set. The answered turn
 * and the gated history record share it so an attachment cannot resolve
 * differently depending on which of the two reads it.
 */
export async function downloadLineInboundMedia(
  messages: readonly LineMessage[],
  context: {
    account: Pick<ResolvedLineAccount, "channelAccessToken">;
    runtime: RuntimeEnv;
    mediaMaxBytes: number;
    turnAdoptionLifecycle?: Pick<LineWebhookTurnAdoptionLifecycle, "abortSignal">;
  },
): Promise<{ allMedia: LineInboundMediaRef[]; mediaUnavailable: boolean }> {
  const { account, runtime, mediaMaxBytes } = context;
  const abortSignal = context.turnAdoptionLifecycle?.abortSignal;
  const allMedia: LineInboundMediaRef[] = [];
  let mediaUnavailable = false;
  for (const message of messages) {
    if (!isDownloadableLineMessageType(message.type)) {
      continue;
    }
    const originalFilename =
      message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
    try {
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes, {
        originalFilename,
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      abortSignal?.throwIfAborted();
      allMedia.push({
        path: media.path,
        contentType: media.contentType,
        // LINE names only file messages; the model needs that name to answer
        // questions that refer to the attachment by it.
        ...(originalFilename ? { fileName: originalFilename } : {}),
      });
    } catch (err) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason;
      }
      if (isRetryableLineInboundMediaError(err)) {
        // Preparation-phase failure before turn adoption: reject so the durable
        // ingress drain retries the whole event once LINE finishes preparing the
        // media, instead of degrading it to an unavailable-attachment notice that
        // permanently loses media with no text fallback.
        throw err;
      }
      mediaUnavailable = true;
      const errMsg = String(err);
      if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
      } else {
        runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
      }
    }
  }
  return { allMedia, mediaUnavailable };
}
