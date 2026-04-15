/**
 * Media消息发送
 *
 * 从 create-sender 中拆出的Media发送逻辑：
 * - 下载并上传Media到 COS
 * - 根据 MIME 类型构建Image或文件Message body
 * - 发送失败时降级为文本链接
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
  /** Media资源 URL */
  mediaUrl: string;
  /** 发送失败时的降级文本 */
  fallbackText?: string;
  /** OpenClaw PluginRuntime 实例 */
  core: PluginRuntime;
  /** 投递目标上下文（account 等均从此获取） */
  dt: DeliverTarget;
  /** 文本降级发送回调（Media发送失败时使用） */
  sendTextFallback: (text: string) => Promise<SendResult>;
}

/**
 * Send media message
 *
 * 下载并上传Media到 COS，根据 MIME 类型构建Image或文件Message body。
 * Falls back to text link on send failure.
 *
 * @param params - 发送参数
 * @returns 发送结果
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
    // Media发送失败，降级为文本链接
    log.error(
      `media send failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`,
    );
    const fallback = fallbackText ? `${fallbackText}\n${mediaUrl}` : mediaUrl;
    return sendTextFallback(fallback);
  }
}
