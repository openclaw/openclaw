/**
 * Sticker 发送模块
 *
 * 参照 media/send.ts 的结构：
 * - buildStickerMsgBody：纯函数，构建 TIMFaceElem Message body
 * - sendSticker：从缓存查找表情 → 构建Message body → deliver 投递
 * - searchSticker：纯查询，不涉及发送
 */

import type { YuanbaoMsgBodyElement } from "../../../types.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";
import { getCachedSticker, searchStickers } from "./sticker-cache.js";
import type { CachedSticker } from "./sticker-types.js";

// ============ 类型定义 ============

export type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

export interface SendStickerParams {
  /** 表情 ID */
  stickerId: string;
  /** 投递目标上下文 */
  dt: DeliverTarget;
}

// ============ 参数归一化 ============

function normalizeStickerSearchQuery(params: Record<string, unknown>): string {
  const raw = params.query ?? params.keyword ?? params.q ?? params.text ?? params.search;
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return "";
}

function normalizeStickerSearchLimit(params: Record<string, unknown>): number {
  const raw = params.limit;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 10;
  }
  return 10;
}

// ============ Message body构建 ============

/**
 * 构建表情Message body
 *
 * 纯函数，将缓存中的表情数据转换为 TIMFaceElem Message body数组。
 * 与 buildImageMsgBody / buildFileMsgBody 对齐。
 *
 * @param sticker - 缓存中的表情数据
 * @returns Message body数组
 */
export function buildStickerMsgBody(sticker: CachedSticker): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: "TIMFaceElem",
      msg_content: {
        index: 0,
        data: JSON.stringify({
          sticker_id: sticker.sticker_id,
          package_id: sticker.package_id,
          width: sticker.width ?? 0,
          height: sticker.height ?? 0,
          formats: sticker.formats ? [sticker.formats] : [],
          name: sticker.name,
        }),
      },
    },
  ];
}

// ============ 发送（供 create-sender 使用） ============

/**
 * Send sticker message
 *
 * 从缓存中查找表情，构建 TIMFaceElem Message body，通过 deliver 投递。
 *
 * @param params - 发送参数
 * @returns 发送结果
 */
export async function sendSticker(params: SendStickerParams): Promise<SendResult> {
  const { stickerId, dt } = params;

  const sticker = getCachedSticker(stickerId);
  if (!sticker) {
    return { ok: false, error: `sticker not found: ${stickerId}` };
  }

  const msgBody = buildStickerMsgBody(sticker);
  return deliver(dt, msgBody);
}

// ============ sticker-search ============

/**
 * Search cached stickers
 *
 * @param params - Action 参数（如 `query`/`limit`）
 * @returns 搜索结果列表
 */
export function searchSticker(params: Record<string, unknown>): ActionResult {
  const query = normalizeStickerSearchQuery(params);
  const limit = normalizeStickerSearchLimit(params);
  const results = searchStickers(query, limit);
  return { ok: true, data: results };
}
