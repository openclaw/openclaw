/**
 * Media message sending.
 *
 * Extracted from create-sender:
 * - Downloads and uploads media to COS
 * - Builds image or file message body based on MIME type
 * - Falls back to text link on send failure
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createLog } from "../../../logger.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import type { SendResult } from "../../outbound/types.js";
import {
  downloadAndUploadMedia,
  guessMimeType,
  buildImageMsgBody,
  buildFileMsgBody,
} from "../../utils/media.js";
import { deliver, type DeliverTarget } from "../deliver.js";

export interface SendMediaParams {
  mediaUrl: string;
  fallbackText?: string;
  core: PluginRuntime;
  dt: DeliverTarget;
  /** Used when media send fails */
  sendTextFallback: (text: string) => Promise<SendResult>;
}

/**
 * Send media message.
 * Downloads and uploads media to COS, builds image or file message body based on MIME type.
 * Falls back to text link on failure.
 */
export async function sendMedia(params: SendMediaParams): Promise<SendResult> {
  const { mediaUrl, fallbackText, core, dt, sendTextFallback } = params;
  const log = createLog("sender");

  try {
    const uploadResult = await downloadAndUploadMedia(mediaUrl, core, dt.account);
    const mime = guessMimeType(uploadResult.filename);
    const msgBody = mime.startsWith("image/")
      ? buildImageMsgBody({
          url: uploadResult.url,
          filename: uploadResult.filename,
          size: uploadResult.size,
          uuid: uploadResult.uuid,
          imageInfo: uploadResult.imageInfo,
        })
      : buildFileMsgBody({
          url: uploadResult.url,
          filename: uploadResult.filename,
          size: uploadResult.size,
          uuid: uploadResult.uuid,
        });
    return deliver(dt, msgBody as YuanbaoMsgBodyElement[]);
  } catch (err) {
    // Media send failed, falling back to text link
    log.error(
      `media send failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
    );
    const fallback = fallbackText ? `${fallbackText}\n${mediaUrl}` : mediaUrl;
    return sendTextFallback(fallback);
  }
}
