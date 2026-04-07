/**
 * smartpage_get_export_result response interceptor
 *
 * Core logic:
 * In the smartpage_get_export_result response returned by the MCP Server, when task_done=true,
 * a content field (markdown text) is included. This content can be large, and returning it
 * directly to the LLM would consume a lot of tokens.
 *
 * In the afterCall stage, this interceptor:
 * 1. Detects when task_done=true and a content field is present
 * 2. Saves content to a local file (using the same media directory as msg-media)
 * 3. Replaces the content field with content_path (the file path)
 *
 * This way, the LLM only sees lightweight file path information, and the Skill can read the full content from the file path.
 */

import { getWeComRuntime } from "../../runtime.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// Interceptor implementation
// ============================================================================

export const smartpageExportInterceptor: CallInterceptor = {
  name: "smartpage-export",

  /** Only applies to the doc-category smartpage_get_export_result method */
  match: (ctx: CallContext) =>
    ctx.category === "doc" && ctx.method === "smartpage_get_export_result",

  /** Intercept the response: save markdown content as a local file */
  async afterCall(_ctx: CallContext, result: unknown): Promise<unknown> {
    return interceptExportResponse(result);
  },
};

// ============================================================================
// Internal implementation
// ============================================================================

/**
 * Intercept the MCP response for smartpage_get_export_result
 *
 * 1. Extract the business JSON from MCP result content[].text
 * 2. Detect when task_done=true and a content field is present
 * 3. Save content (markdown text) to the local media directory via saveMediaBuffer
 * 4. Build a new response: remove content and add content_path
 */
async function interceptExportResponse(result: unknown): Promise<unknown> {
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

  // 3. Validate: return as-is if errcode !== 0, task_done is not true, or content is missing
  if (bizData.errcode !== 0) {
    return result;
  }
  if (bizData.task_done !== true) {
    return result;
  }
  if (typeof bizData.content !== "string") {
    return result;
  }

  const markdownContent = bizData.content;

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
    undefined, // maxBytes: markdown 文本通常不大，使用默认限制
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

  // 6. Return modified MCP result structure
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(newBizData),
      },
    ],
  };
}
