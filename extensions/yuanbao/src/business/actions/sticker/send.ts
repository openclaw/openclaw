/**
 * Sticker send module.
 *
 * Follows the structure of media/send.ts:
 * - buildStickerMsgBody: pure function, builds TIMFaceElem message body
 * - sendSticker: lookup sticker from cache → build message body → deliver
 * - searchSticker: query only, no sending
 */

import type { YuanbaoMsgBodyElement } from "../../../types.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";
import { getCachedSticker, searchStickers } from "./sticker-cache.js";
import type { CachedSticker } from "./sticker-types.js";

// ============ Type definitions ============

export type ActionResult = { ok: true; data?: unknown } | { ok: false; error: string };

export interface SendStickerParams {
  /** Sticker ID */
  stickerId: string;
  /** Delivery target context */
  dt: DeliverTarget;
}

// ============ Parameter normalization ============

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

// ============ Message body building ============

/**
 * Build sticker message body.
 * Pure function, converts cached sticker data to TIMFaceElem message body array.
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

// ============ Send (used by create-sender) ============

/**
 * Send sticker message.
 * Looks up sticker from cache, builds TIMFaceElem message body, delivers via deliver().
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
 * Search cached stickers.
 */
export function searchSticker(params: Record<string, unknown>): ActionResult {
  const query = normalizeStickerSearchQuery(params);
  const limit = normalizeStickerSearchLimit(params);
  const results = searchStickers(query, limit);
  return { ok: true, data: results };
}
