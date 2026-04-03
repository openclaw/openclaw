/**
 * get_msg_media 响应拦截器
 *
 * 核心逻辑：
 * 1. beforeCall: 设置延长的超时时间（120s），因为 base64 数据可达 ~27MB
 * 2. afterCall: 从 MCP result 的 content[].text 中提取 base64_data，
 *    解码为 Buffer 并通过 saveMediaBuffer 保存到本地媒体目录，
 *    替换响应中的 base64_data 为 local_path，避免大模型被 base64 数据消耗 token
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MEDIA_DOWNLOAD_TIMEOUT_MS } from "../transport.js";
import { getWeComRuntime } from "../../runtime.js";
import { detectMime } from "../../openclaw-compat.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// 拦截器实现
// ============================================================================

export const mediaInterceptor: CallInterceptor = {
  name: "media",

  /** 仅对 get_msg_media 方法生效 */
  match: (ctx: CallContext) => ctx.method === "get_msg_media",

  /** 设置延长的超时时间 */
  beforeCall() {
    return { timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS };
  },

  /** 拦截响应：base64 → 本地文件 */
  async afterCall(ctx: CallContext, result: unknown): Promise<unknown> {
    return interceptMediaResponse(result);
  },
};

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 拦截 get_msg_media 的 MCP 响应
 *
 * 1. 从 MCP result 的 content[].text 中提取业务 JSON
 * 2. 提取 media_item.base64_data，解码为 Buffer
 * 3. 通过 openclaw SDK 的 saveMediaBuffer 保存到本地媒体目录
 * 4. 替换响应：移除 base64_data，加入 local_path
 *
 * 这样大模型只看到轻量的文件路径信息，不会被 base64 数据消耗 token。
 */
async function interceptMediaResponse(result: unknown): Promise<unknown> {
  const t0 = performance.now();

  // 1. 提取 MCP result 中的 content 数组
  const content = (result as Record<string, unknown>)?.content;
  if (!Array.isArray(content)) return result;

  const textItem = content.find(
    (c: Record<string, unknown>) => c.type === "text" && typeof c.text === "string",
  ) as { type: string; text: string } | undefined;
  if (!textItem) return result;

  // 2. 解析业务 JSON
  let bizData: Record<string, unknown>;
  try {
    bizData = JSON.parse(textItem.text) as Record<string, unknown>;
  } catch {
    // 非 JSON 格式，原样返回
    return result;
  }

  // 3. 校验业务响应：errcode !== 0 或无 media_item 时原样返回
  if (bizData.errcode !== 0) return result;

  const mediaItem = bizData.media_item as Record<string, unknown> | undefined;
  if (!mediaItem || typeof mediaItem.base64_data !== "string") return result;

  const base64Data = mediaItem.base64_data as string;
  const mediaName = mediaItem.name as string | undefined;
  const mediaType = mediaItem.type as string | undefined;
  const mediaId = mediaItem.media_id as string | undefined;

  const tParsed = performance.now();

  // 4. 解码 base64 → Buffer
  const buffer = Buffer.from(base64Data, "base64");
  const tDecoded = performance.now();

  // 5. 检测 contentType，并通过 saveMediaBuffer 保存到本地媒体目录
  const contentType = await detectMime({ buffer, filePath: mediaName }) ?? "application/octet-stream";
  const tMimeDetected = performance.now();

  // 企业微信聊天记录附件可达 20MB（文件消息上限），
  // 而 saveMediaBuffer 默认 maxBytes 为 5MB（针对 outbound 场景），
  // 此处显式放宽到 20MB 以支持大文件下载。
  const INBOUND_MAX_BYTES = 20 * 1024 * 1024; // 20MB

  const core = getWeComRuntime();
  const saved = await core.channel.media.saveMediaBuffer(
    buffer,
    contentType,
    "inbound",
    INBOUND_MAX_BYTES,   // maxBytes: 放宽到 20MB，匹配企业微信文件消息上限
    mediaName,           // originalFilename: 保留原始文件名
  );

  // 5.1 补偿：核心库 EXT_BY_MIME 可能缺少某些格式映射（如 audio/amr），
  //     导致保存的文件没有后缀。此处检测并修复。
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
      // rename 失败不影响主流程，文件仍可用
    }
  }

  const tSaved = performance.now();

  // 6. 构造精简响应，移除 base64_data，加入本地路径
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

  // 耗时日志：各环节耗时（ms）
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

  // 7. 返回修改后的 MCP result 结构
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(newBizData),
    }],
  };
}
