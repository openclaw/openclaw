/**
 * smartpage_create Request Interceptor
 *
 * Core logic:
 * The pages array in smartpage_create may contain a page_filepath field per page
 * (pointing to a local markdown file), to avoid passing large text content via command line.
 * This interceptor traverses the pages array during beforeCall, reads each page_filepath's
 * local file content, fills it into page_content, and removes page_filepath.
 *
 * Input convention:
 *   wecom_mcp call doc smartpage_create '{
 *     "title": "Main page title",
 *     "pages": [
 *       {"page_title": "Page 1", "page_filepath": "/tmp/page1.md", "content_type": "markdown"},
 *       {"page_title": "Page 2", "page_filepath": "/tmp/page2.md", "content_type": "markdown"}
 *     ]
 *   }'
 *
 * Interceptor behavior:
 *   1. Detect args.pages array
 *   2. Validate file size: single file must not exceed 10MB, total must not exceed 20MB
 *   3. Traverse each page; if page_filepath exists, read local file content
 *   4. Fill file content into page_content field, remove page_filepath
 *   5. Return modified complete args
 *
 * Format sent to MCP Server:
 *   { "title": "...", "pages": [{"page_title": "...", "page_content": "...", "content_type": "..."}] }
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CallInterceptor, CallContext, BeforeCallOptions } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Max file size per page_filepath: 10MB */
const MAX_SINGLE_FILE_SIZE = 10 * 1024 * 1024;
/** Max total file size for all page_filepaths: 20MB */
const MAX_TOTAL_FILE_SIZE = 20 * 1024 * 1024;

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Validate file sizes of all page_filepaths
 *
 * Uses fs.stat to check sizes before reading file content, avoiding loading oversized files into memory.
 * - Single file > 10MB → error
 * - Cumulative total > 20MB → error
 */
async function validateFileSize(pages: Record<string, unknown>[]): Promise<void> {
  let totalSize = 0;

  for (let i = 0; i < pages.length; i++) {
    const filePath = pages[i].page_filepath;
    if (typeof filePath !== "string" || !filePath) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // stat failure not handled here; left for the subsequent readFile phase to throw a more detailed error
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

/** Asynchronously resolve page_filepath in pages, return BeforeCallOptions */
async function resolvePages(
  ctx: CallContext,
  pages: Record<string, unknown>[],
): Promise<BeforeCallOptions> {
  console.log(`[mcp] smartpage_create: 开始解析 ${pages.length} 个 page 的 page_filepath`);

  // Phase 1: File size validation (stat phase, no content reading)
  await validateFileSize(pages);

  // Phase 2: Read file content
  const resolvedPages = await Promise.all(
    pages.map(async (page: Record<string, unknown>, index: number) => {
      const filePath = page.page_filepath;
      if (typeof filePath !== "string" || !filePath) {
        // This page has no page_filepath; keep as-is (may already have page_content)
        return page;
      }

      let fileContent: string;
      try {
        // Validate path against trusted roots to prevent arbitrary file reads
        // Use realpath to resolve symlinks and prevent symlink-based escapes
        let resolved: string;
        try {
          resolved = await fs.realpath(path.resolve(filePath));
        } catch {
          resolved = path.resolve(filePath);
        }
        const trustedRoots = [process.cwd(), "/tmp"];
        const realTrustedRoots = await Promise.all(
          trustedRoots.map(async (root) => {
            try {
              return await fs.realpath(path.resolve(root));
            } catch {
              return path.resolve(root);
            }
          }),
        );
        const inTrustedRoot = realTrustedRoots.some((r) => {
          return resolved === r || resolved.startsWith(r + path.sep);
        });
        if (!inTrustedRoot) {
          throw new Error(`路径 "${filePath}" 不在允许的目录范围内（仅允许工作目录和 /tmp）`);
        }
        fileContent = await fs.readFile(resolved, "utf-8");
      } catch (err) {
        throw new Error(
          `smartpage_create: pages[${index}] 无法读取文件 "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      console.log(
        `[mcp] smartpage_create: pages[${index}] 读取成功 "${filePath}" (${fileContent.length} chars)`,
      );

      // Build new page object: fill in page_content, remove page_filepath
      const { page_filepath: _, ...rest } = page;
      return { ...rest, page_content: fileContent };
    }),
  );

  console.log(`[mcp] smartpage_create: 所有 page_filepath 解析完成`);

  // Return modified complete args
  return {
    args: {
      ...ctx.args,
      pages: resolvedPages,
    },
  };
}

// ============================================================================
// Interceptor Implementation
// ============================================================================

export const smartpageCreateInterceptor: CallInterceptor = {
  name: "smartpage-create",

  /** Only applies to doc category's smartpage_create method */
  match: (ctx: CallContext) => ctx.category === "doc" && ctx.method === "smartpage_create",

  /** Traverse pages array, read each page_filepath and fill into page_content */
  beforeCall(ctx: CallContext) {
    const pages = ctx.args.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      // No pages array, don't intercept
      return undefined;
    }

    // Check if any page contains page_filepath
    const hasFilePath = pages.some(
      (p: Record<string, unknown>) => typeof p.page_filepath === "string" && p.page_filepath,
    );
    if (!hasFilePath) {
      // All pages lack page_filepath (may have page_content directly), don't intercept
      return undefined;
    }

    return resolvePages(ctx, pages);
  },
};
