/**
 * get_msg_media response interceptor
 *
 * Core logic:
 * 1. beforeCall: set an extended timeout (120s) because the base64 payload can reach ~27MB
 * 2. afterCall: extract base64_data from MCP result content[].text,
 *    decode it into a Buffer, save it to the local media directory via saveMediaBuffer,
 *    and replace base64_data in the response with local_path so the model does not waste tokens on base64 data
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectMime } from "../../openclaw-compat.js";
import { getWeComRuntime } from "../../runtime.js";
import { MEDIA_DOWNLOAD_TIMEOUT_MS } from "../transport.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// Interceptor implementation
// ============================================================================

export const mediaInterceptor: CallInterceptor = {
  name: "media",

  /** Only applies to the get_msg_media method */
  match: (ctx: CallContext) => ctx.method === "get_msg_media",

  /** Set an extended timeout */
  beforeCall() {
    return { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS };
  },

  /** Intercept the response: base64 → local file */
  async afterCall(ctx: CallContext, result: unknown): Promise<unknown> {
    return interceptMediaResponse(result);
  },
};

// ============================================================================
// Internal implementation
// ============================================================================

/**
 * Intercept the MCP response for get_msg_media
 *
 * 1. Extract the business JSON from MCP result content[].text
 * 2. Extract media_item.base64_data and decode it into a Buffer
 * 3. Save it to the local media directory using the OpenClaw SDK's saveMediaBuffer
 * 4. Rewrite the response: remove base64_data and add local_path
 *
 * This way, the model only sees lightweight file path information instead of spending tokens on base64 data.
 */
async function interceptMediaResponse(result: unknown): Promise<unknown> {
  const t0 = performance.now();

  // 1. Extract the content array from the MCP result
  const content = (result as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) {
    return result;
  }

  const textItem = content.find(
    (c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string",
  ) as { type: string; text: string } | undefined;
  if (!textItem) {
    return result;
  }

  // 2. Parse the business JSON
  let bizData: Record<string, unknown>;
  try {
    bizData = JSON.parse(textItem.text) as Record<string, unknown>;
  } catch {
    // Not JSON; return as-is
    return result;
  }

  // 3. Validate the business response: return as-is if errcode !== 0 or media_item is missing
  if (bizData.errcode !== 0) {
    return result;
  }

  const mediaItem = bizData.media_item as Record<string, unknown> | undefined;
  if (!mediaItem || typeof mediaItem.base64_data !== "string") {
    return result;
  }

  const base64Data = mediaItem.base64_data;
  const mediaName = mediaItem.name as string | undefined;
  const mediaType = mediaItem.type as string | undefined;
  const mediaId = mediaItem.media_id as string | undefined;

  const tParsed = performance.now();

  // 4. Decode base64 → Buffer
  const buffer = Buffer.from(base64Data, "base64");
  const tDecoded = performance.now();

  // 5. Detect contentType and save it to the local media directory via saveMediaBuffer
  const contentType =
    (await detectMime({ buffer, filePath: mediaName })) ?? "application/octet-stream";
  const tMimeDetected = performance.now();

  // WeCom chat record attachments can reach 20MB (the file message limit),
  // while saveMediaBuffer defaults maxBytes to 5MB (for outbound scenarios),
  // so we explicitly raise it to 20MB here to support large file downloads.
  const INBOUND_MAX_BYTES = 20 * 1024 * 1024; // 20MB

  const core = getWeComRuntime();
  const saved = await core.channel.media.saveMediaBuffer(
    buffer,
    contentType,
    "inbound",
    INBOUND_MAX_BYTES, // maxBytes: increase to 20MB to match the WeCom file message limit
    mediaName, // originalFilename: preserve the original filename
  );

  // 5.1 Compensation: the core library's EXT_BY_MIME may be missing mappings for some formats (such as audio/amr),
  //     causing saved files to have no extension. Detect and fix that here.
  const MIME_EXT_PATCH: Record<string, string> = {
    "audio/amr": ".amr",
  };
  const patchExt = MIME_EXT_PATCH[contentType];
  if (patchExt && !path.extname(saved.path)) {
    const newPath = saved.path + patchExt;
    try {
      await fs.rename(saved.path, newPath);
      saved.path = newPath;
    } catch {
      // A rename failure does not affect the main flow; the file remains usable
    }
  }

  const tSaved = performance.now();

  // 6. Build a slimmed-down response: remove base64_data and add the local path
  const newBizData = {
    errcode: 0,
    errmsg: "ok",
    media_item: {
      media_id: mediaId,
      name: mediaName ?? saved.path.split("/").pop(),
      type: mediaType,
      local_path: saved.path,
      size: buffer.length,
      content_type: saved.contentType,
    },
  };

  const tEnd = performance.now();

  // Timing log: per-stage durations (ms)
  console.log(
    `[mcp] get_msg_media 拦截成功: media_id=${mediaId ?? "unknown"}, ` +
      `type=${mediaType ?? "unknown"}, size=${buffer.length}, saved=${saved.path}\n` +
      `  ⏱ 耗时明细 (总 ${(tEnd - t0).toFixed(1)}ms):\n` +
      `    解析响应 JSON:   ${(tParsed - t0).toFixed(1)}ms\n` +
      `    base64 解码:     ${(tDecoded - tParsed).toFixed(1)}ms  (${(base64Data.length / 1024).toFixed(0)}KB base64 → ${(buffer.length / 1024).toFixed(0)}KB buffer)\n` +
      `    MIME 检测:       ${(tMimeDetected - tDecoded).toFixed(1)}ms  (${contentType})\n` +
      `    saveMediaBuffer: ${(tSaved - tMimeDetected).toFixed(1)}ms\n` +
      `    构造响应:        ${(tEnd - tSaved).toFixed(1)}ms`,
  );

  // 7. Return modified MCP result structure
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(newBizData),
      },
    ],
  };
}
