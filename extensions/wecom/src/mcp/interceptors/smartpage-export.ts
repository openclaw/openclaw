/**
 * smartpage_get_export_result 响应拦截器
 *
 * 核心逻辑：
 * MCP Server 返回的 smartpage_get_export_result 响应中，当 task_done=true 时
 * 会包含 content 字段（markdown 文本内容）。该内容可能很大，直接返回给 LLM
 * 会消耗大量 token。
 *
 * 本拦截器在 afterCall 阶段：
 * 1. 检测 task_done=true 且存在 content 字段
 * 2. 将 content 保存到本地文件（使用与 msg-media 一致的媒体目录）
 * 3. 用 content_path（文件路径）替换 content 字段
 *
 * 这样 LLM 只看到轻量的文件路径信息，Skill 可通过文件路径读取完整内容。
 */

import { getWeComRuntime } from "../../runtime.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// 拦截器实现
// ============================================================================

export const smartpageExportInterceptor: CallInterceptor = {
  name: "smartpage-export",

  /** 仅对 doc 品类的 smartpage_get_export_result 方法生效 */
  match: (ctx: CallContext) => ctx.category === "doc" && ctx.method === "smartpage_get_export_result",

  /** 拦截响应：将 markdown content 保存为本地文件 */
  async afterCall(_ctx: CallContext, result: unknown): Promise<unknown> {
    return interceptExportResponse(result);
  },
};

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 拦截 smartpage_get_export_result 的 MCP 响应
 *
 * 1. 从 MCP result 的 content[].text 中提取业务 JSON
 * 2. 检测 task_done=true 且存在 content 字段
 * 3. 将 content（markdown 文本）通过 saveMediaBuffer 保存到本地媒体目录
 * 4. 构造新响应：移除 content，添加 content_path
 */
async function interceptExportResponse(result: unknown): Promise<unknown> {
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

  // 3. 校验：errcode !== 0 或 task_done 不为 true 或无 content 时原样返回
  if (bizData.errcode !== 0) return result;
  if (bizData.task_done !== true) return result;
  if (typeof bizData.content !== "string") return result;

  const markdownContent = bizData.content as string;

  console.log(
    `[mcp] smartpage_get_export_result: 拦截 content (${markdownContent.length} chars)，保存到本地文件`,
  );

  // 4. 将 markdown 内容通过 saveMediaBuffer 保存到本地媒体目录
  //    使用 text/markdown 类型，与 msg-media 拦截器保持一致的路径管理
  const buffer = Buffer.from(markdownContent, "utf-8");
  const core = getWeComRuntime();
  const saved = await core.channel.media.saveMediaBuffer(
    buffer,
    "text/markdown",
    "inbound",
    undefined,            // maxBytes: markdown 文本通常不大，使用默认限制
    "smartpage_export.md", // originalFilename
  );

  console.log(`[mcp] smartpage_get_export_result: 已保存到 ${saved.path}`);

  // 5. 构造新响应：移除 content，添加 content_path
  const newBizData = {
    errcode: bizData.errcode,
    errmsg: bizData.errmsg ?? "ok",
    task_done: true,
    content_path: saved.path,
  };

  // 6. 返回修改后的 MCP result 结构
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(newBizData),
    }],
  };
}
