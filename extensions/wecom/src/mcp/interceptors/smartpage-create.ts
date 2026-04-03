/**
 * smartpage_create 请求拦截器
 *
 * 核心逻辑：
 * smartpage_create 的 pages 数组中，每个 page 可能包含 page_filepath 字段
 * （指向本地 markdown 文件），用于避免在命令行传递大段文本内容。
 * 本拦截器在 beforeCall 阶段遍历 pages 数组，逐个读取 page_filepath
 * 指向的本地文件内容，填入 page_content 字段，并移除 page_filepath。
 *
 * 入参约定：
 *   wecom_mcp call doc smartpage_create '{
 *     "title": "主页标题",
 *     "pages": [
 *       {"page_title": "页面1", "page_filepath": "/tmp/page1.md", "content_type": "markdown"},
 *       {"page_title": "页面2", "page_filepath": "/tmp/page2.md", "content_type": "markdown"}
 *     ]
 *   }'
 *
 * 拦截器行为：
 *   1. 检测 args.pages 数组
 *   2. 校验文件大小：单文件不超过 10MB，所有文件总计不超过 20MB
 *   3. 遍历每个 page，若存在 page_filepath 则读取本地文件内容
 *   4. 将文件内容填入 page_content 字段，移除 page_filepath
 *   5. 返回修改后的完整 args
 *
 * 传给 MCP Server 的格式：
 *   { "title": "...", "pages": [{"page_title": "...", "page_content": "...", "content_type": "..."}] }
 */

import * as fs from "node:fs/promises";
import type { CallInterceptor, CallContext, BeforeCallOptions } from "./types.js";

// ============================================================================
// 常量
// ============================================================================

/** 单个 page_filepath 文件大小上限：10MB */
const MAX_SINGLE_FILE_SIZE = 10 * 1024 * 1024;
/** 所有 page_filepath 文件总大小上限：20MB */
const MAX_TOTAL_FILE_SIZE = 20 * 1024 * 1024;

// ============================================================================
// 内部辅助函数
// ============================================================================

/**
 * 校验所有 page_filepath 的文件大小
 *
 * 使用 fs.stat 在读取文件内容之前检查大小，避免超大文件被加载到内存。
 * - 单文件 > 10MB → 报错
 * - 所有文件累计 > 20MB → 报错
 */
async function validateFileSize(
  pages: Record<string, unknown>[],
): Promise<void> {
  let totalSize = 0;

  for (let i = 0; i < pages.length; i++) {
    const filePath = pages[i].page_filepath;
    if (typeof filePath !== "string" || !filePath) continue;

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      // stat 失败不在这里处理，留给后续 readFile 阶段抛出更详细的错误
      continue;
    }

    if (stat.size > MAX_SINGLE_FILE_SIZE) {
      console.error(
        `[mcp] smartpage_create: pages[${i}] 文件 "${filePath}" ` +
        `大小 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过单文件上限 10MB`,
      );
      throw new Error("内容大小超出限制，无法创建");
    }

    totalSize += stat.size;
    if (totalSize > MAX_TOTAL_FILE_SIZE) {
      console.error(
        `[mcp] smartpage_create: 累计文件大小 ${(totalSize / 1024 / 1024).toFixed(1)}MB ` +
        `超过总上限 20MB（在 pages[${i}] "${filePath}" 处超出）`,
      );
      throw new Error("内容大小超出限制，无法创建");
    }
  }

  if (totalSize > 0) {
    console.log(
      `[mcp] smartpage_create: 文件大小校验通过，总计 ${(totalSize / 1024 / 1024).toFixed(2)}MB`,
    );
  }
}

/** 异步解析 pages 中的 page_filepath，返回 BeforeCallOptions */
async function resolvePages(
  ctx: CallContext,
  pages: Record<string, unknown>[],
): Promise<BeforeCallOptions> {
  console.log(`[mcp] smartpage_create: 开始解析 ${pages.length} 个 page 的 page_filepath`);

  // 阶段 1：文件大小校验（stat 阶段，不读内容）
  await validateFileSize(pages);

  // 阶段 2：读取文件内容
  const resolvedPages = await Promise.all(
    pages.map(async (page: Record<string, unknown>, index: number) => {
      const filePath = page.page_filepath;
      if (typeof filePath !== "string" || !filePath) {
        // 该 page 没有 page_filepath，保留原样（可能已有 page_content）
        return page;
      }

      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, "utf-8");
      } catch (err) {
        throw new Error(
          `smartpage_create: pages[${index}] 无法读取文件 "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      console.log(
        `[mcp] smartpage_create: pages[${index}] 读取成功 "${filePath}" (${fileContent.length} chars)`,
      );

      // 构造新的 page 对象：填入 page_content，移除 page_filepath
      const { page_filepath: _, ...rest } = page;
      return { ...rest, page_content: fileContent };
    }),
  );

  console.log(`[mcp] smartpage_create: 所有 page_filepath 解析完成`);

  // 返回修改后的完整 args
  return {
    args: {
      ...ctx.args,
      pages: resolvedPages,
    },
  };
}

// ============================================================================
// 拦截器实现
// ============================================================================

export const smartpageCreateInterceptor: CallInterceptor = {
  name: "smartpage-create",

  /** 仅对 doc 品类的 smartpage_create 方法生效 */
  match: (ctx: CallContext) => ctx.category === "doc" && ctx.method === "smartpage_create",

  /** 遍历 pages 数组，逐个读取 page_filepath 填入 page_content */
  beforeCall(ctx: CallContext) {
    const pages = ctx.args.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      // 没有 pages 数组，不做拦截
      return undefined;
    }

    // 检查是否有任何 page 包含 page_filepath
    const hasFilePath = pages.some(
      (p: Record<string, unknown>) => typeof p.page_filepath === "string" && p.page_filepath,
    );
    if (!hasFilePath) {
      // 所有 page 都没有 page_filepath（可能直接传了 page_content），不做拦截
      return undefined;
    }

    return resolvePages(ctx, pages);
  },
};
