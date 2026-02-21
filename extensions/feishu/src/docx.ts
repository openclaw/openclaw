import { Readable } from "stream";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { FeishuDocSchema, type FeishuDocParams } from "./doc-schema.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  hasFeishuToolEnabledForAnyAccount,
  withFeishuToolClient,
} from "./tools-common/tool-exec.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/** Extract image URLs from markdown content */
function extractImageUrls(markdown: string): string[] {
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const urls: string[] = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const url = match[1].trim();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      urls.push(url);
    }
  }
  return urls;
}

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: "Page",
  2: "Text",
  3: "Heading1",
  4: "Heading2",
  5: "Heading3",
  12: "Bullet",
  13: "Ordered",
  14: "Code",
  15: "Quote",
  17: "Todo",
  18: "Bitable",
  21: "Diagram",
  22: "Divider",
  23: "File",
  27: "Image",
  30: "Sheet",
  31: "Table",
  32: "TableCell",
};

// Block types that cannot be created via documentBlockChildren.create API
const UNSUPPORTED_CREATE_TYPES = new Set([32]);

/**
 * Reorder blocks according to firstLevelBlockIds from convertMarkdown API.
 * The API returns blocks as a flat unordered array across all levels.
 * firstLevelBlockIds provides the correct top-level document order.
 */
function reorderBlocks(blocks: any[], firstLevelBlockIds: string[]): any[] {
  if (!firstLevelBlockIds || firstLevelBlockIds.length === 0) return blocks;

  const blockMap = new Map<string, any>();
  for (const block of blocks) {
    if (block.block_id) {
      blockMap.set(block.block_id, block);
    }
  }

  const ordered: any[] = [];
  for (const id of firstLevelBlockIds) {
    const block = blockMap.get(id);
    if (block) {
      ordered.push(block);
    }
  }

  // If mapping unexpectedly fails, fall back to original to avoid hard data loss.
  return ordered.length > 0 ? ordered : blocks;
}

/** Clean blocks for insertion (remove unsupported types and read-only fields) */
function cleanBlocksForInsert(blocks: any[]): { cleaned: any[]; skipped: string[] } {
  const skipped: string[] = [];
  const cleaned = blocks
    .filter((block) => {
      if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
        const typeName = BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`;
        skipped.push(typeName);
        return false;
      }
      return true;
    })
    .map((block) => {
      const cleanedBlock = { ...block };
      delete cleanedBlock.block_id;
      delete cleanedBlock.parent_id;
      delete cleanedBlock.children;

      // Table cell IDs and merge metadata are not accepted in create payload.
      if (cleanedBlock.block_type === 31 && cleanedBlock.table) {
        const property = cleanedBlock.table.property ?? {};
        const { merge_info, ...propertyRest } = property;
        cleanedBlock.table = { property: propertyRest };
      }

      return cleanedBlock;
    });
  return { cleaned, skipped };
}

function buildBlockMap(blocks: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const block of blocks) {
    if (block.block_id) map.set(block.block_id, block);
  }
  return map;
}

type InsertResult = { children: any[]; skipped: string[]; warnings: string[] };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Known transient/throughput-related Feishu codes observed across endpoints.
// Code matching is primary; message matching is fallback for undocumented new codes.
const RETRYABLE_CREATE_ERROR_CODES = new Set<number>([
  429, // HTTP-like throttle surfaces in some SDK wrappers
  1254290, // Too many requests
  1254291, // Write conflict
  1255040, // Request timeout
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  /\brate\b/i,
  /\bfrequency\b/i,
  /\btoo many\b/i,
  /\blimit\b/i,
  /\bqps\b/i,
  /频率/u,
  /限流/u,
];

function isRetryableCreateError(code?: number, msg?: string) {
  if (!code || code === 0) return false;
  if (RETRYABLE_CREATE_ERROR_CODES.has(code)) return true;
  const text = msg ?? "";
  return RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(text));
}

const CREATE_CHILDREN_RETRY_POLICY = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 2500,
  jitterRatio: 0.2,
} as const;

function computeBackoffDelayMs(attempt: number, policy = CREATE_CHILDREN_RETRY_POLICY) {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jitter = exp * policy.jitterRatio;
  const min = Math.max(0, exp - jitter);
  const max = exp + jitter;
  return Math.round(min + Math.random() * (max - min));
}

type CreateChildrenPayload = Parameters<Lark.Client["docx"]["documentBlockChildren"]["create"]>[0];
type CreateChildrenResponse = Awaited<
  ReturnType<Lark.Client["docx"]["documentBlockChildren"]["create"]>
>;

async function executeWithBackoff<T>(args: {
  operationName: string;
  operation: () => Promise<T>;
  isSuccess: (result: T) => boolean;
  shouldRetry: (result: T) => boolean;
  getMessage: (result: T) => string | undefined;
  policy?: typeof CREATE_CHILDREN_RETRY_POLICY;
}): Promise<T> {
  const policy = args.policy ?? CREATE_CHILDREN_RETRY_POLICY;
  let lastResult: T | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    const result = await args.operation();
    lastResult = result;

    if (args.isSuccess(result)) return result;
    if (!args.shouldRetry(result) || attempt === policy.maxAttempts) return result;

    const delayMs = computeBackoffDelayMs(attempt, policy);
    const msg = args.getMessage(result) ?? "unknown error";
    console.warn(
      `[feishu_doc] ${args.operationName} retry ${attempt}/${policy.maxAttempts - 1} after ${delayMs}ms: ${msg}`,
    );
    await sleep(delayMs);
  }

  return lastResult!;
}

async function createChildrenWithRetry(
  client: Lark.Client,
  payload: CreateChildrenPayload,
  policy = CREATE_CHILDREN_RETRY_POLICY,
) {
  return executeWithBackoff<CreateChildrenResponse>({
    operationName: "docx.documentBlockChildren.create",
    operation: () => client.docx.documentBlockChildren.create(payload),
    isSuccess: (res) => res.code === 0,
    shouldRetry: (res) => isRetryableCreateError(res.code, res.msg),
    getMessage: (res) => res.msg,
    policy,
  });
}

async function insertTableWithCells(
  client: Lark.Client,
  docToken: string,
  tableBlock: any,
  blockMap: Map<string, any>,
  parentBlockId?: string,
): Promise<InsertResult> {
  const tableInsert = await insertBlocks(client, docToken, [tableBlock], parentBlockId);
  const insertedTable = tableInsert.children[0];

  if (!insertedTable || insertedTable.block_type !== 31) {
    return {
      children: tableInsert.children,
      skipped: tableInsert.skipped,
      warnings: ["Table block was not returned after create; skipped table cell content."],
    };
  }

  const srcCells: string[] = tableBlock.table?.cells ?? [];
  const dstCells: string[] = insertedTable.table?.cells ?? [];
  if (srcCells.length === 0) {
    return { children: tableInsert.children, skipped: tableInsert.skipped, warnings: [] };
  }

  if (dstCells.length === 0) {
    return {
      children: tableInsert.children,
      skipped: tableInsert.skipped,
      warnings: [
        "Table created but API did not return generated cells; table content may be empty.",
      ],
    };
  }

  const copiedChildren: any[] = [];
  const allSkipped = [...tableInsert.skipped];
  const warnings: string[] = [];
  let sourceCellsWithContent = 0;
  let copiedCellCount = 0;

  const cellCount = Math.min(srcCells.length, dstCells.length);
  for (let i = 0; i < cellCount; i++) {
    const srcCellId = srcCells[i];
    const dstCellId = dstCells[i];
    const srcCell = blockMap.get(srcCellId);
    const srcChildIds: string[] = srcCell?.children ?? [];
    let srcChildBlocks = srcChildIds
      .map((id) => blockMap.get(id))
      .filter((b): b is any => Boolean(b));

    // Some convert payloads may carry plain text directly on table_cell.
    if (srcChildBlocks.length === 0 && srcCell?.text?.elements?.length) {
      srcChildBlocks = [{ block_type: 2, text: srcCell.text }];
    }
    if (srcChildBlocks.length === 0 && srcCell?.table_cell?.text?.elements?.length) {
      srcChildBlocks = [{ block_type: 2, text: srcCell.table_cell.text }];
    }

    if (srcChildBlocks.length === 0) continue;
    sourceCellsWithContent++;

    const cellInsert = await insertBlocksInBatches(client, docToken, srcChildBlocks, dstCellId);
    copiedChildren.push(...cellInsert.children);
    allSkipped.push(...cellInsert.skipped);
    if (cellInsert.children.length > 0) copiedCellCount++;
  }

  if (srcCells.length !== dstCells.length) {
    warnings.push(
      `Table cell count mismatch after create (source=${srcCells.length}, target=${dstCells.length}); content may be partially copied.`,
    );
  }
  if (sourceCellsWithContent > 0 && copiedCellCount < sourceCellsWithContent) {
    warnings.push(
      `Copied table cell content for ${copiedCellCount}/${sourceCellsWithContent} non-empty cells.`,
    );
  }

  return {
    children: [...tableInsert.children, ...copiedChildren],
    skipped: [...new Set(allSkipped)],
    warnings,
  };
}

async function insertBlocksPreservingTables(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  blockMap: Map<string, any>,
  parentBlockId?: string,
): Promise<InsertResult> {
  const inserted: any[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const buffer: any[] = [];

  const flushBuffer = async () => {
    if (buffer.length === 0) return;
    const res = await insertBlocksInBatches(client, docToken, buffer, parentBlockId);
    inserted.push(...res.children);
    skipped.push(...res.skipped);
    buffer.length = 0;
  };

  for (const block of blocks) {
    if (block.block_type === 31) {
      await flushBuffer();
      const tableRes = await insertTableWithCells(client, docToken, block, blockMap, parentBlockId);
      inserted.push(...tableRes.children);
      skipped.push(...tableRes.skipped);
      warnings.push(...tableRes.warnings);
      continue;
    }
    buffer.push(block);
  }

  await flushBuffer();

  return {
    children: inserted,
    skipped: [...new Set(skipped)],
    warnings: [...new Set(warnings)],
  };
}

// ============ Core Functions ============

async function convertMarkdown(client: Lark.Client, markdown: string) {
  const res = await client.docx.document.convert({
    data: { content_type: "markdown", content: markdown },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  };
}

async function insertBlocks(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  parentBlockId?: string,
): Promise<{ children: any[]; skipped: string[] }> {
  const { cleaned, skipped } = cleanBlocksForInsert(blocks);
  const blockId = parentBlockId ?? docToken;

  if (cleaned.length === 0) {
    return { children: [], skipped };
  }

  const res = await createChildrenWithRetry(client, {
    path: { document_id: docToken, block_id: blockId },
    data: { children: cleaned },
  });
  if (res.code !== 0) throw new Error(res.msg);
  return { children: res.data?.children ?? [], skipped };
}

async function clearDocumentContent(client: Lark.Client, docToken: string) {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (existing.code !== 0) throw new Error(existing.msg);

  const childIds =
    existing.data?.items
      ?.filter((b) => b.parent_id === docToken && b.block_type !== 1)
      .map((b) => b.block_id) ?? [];

  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) throw new Error(res.msg);
  }

  return childIds.length;
}

async function uploadImageToDocx(
  client: Lark.Client,
  blockId: string,
  imageBuffer: Buffer,
  fileName: string,
): Promise<string> {
  const res = await client.drive.media.uploadAll({
    data: {
      file_name: fileName,
      parent_type: "docx_image",
      parent_node: blockId,
      size: imageBuffer.length,
      file: Readable.from(imageBuffer) as any,
    },
  });

  const fileToken = res?.file_token;
  if (!fileToken) {
    throw new Error("Image upload failed: no file_token returned");
  }
  return fileToken;
}

async function downloadImage(url: string, maxBytes: number): Promise<Buffer> {
  const fetched = await getFeishuRuntime().channel.media.fetchRemoteMedia({ url, maxBytes });
  return fetched.buffer;
}

async function processImages(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  insertedBlocks: any[],
  maxBytes: number,
): Promise<number> {
  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length === 0) return 0;

  const imageBlocks = insertedBlocks.filter((b) => b.block_type === 27);

  let processed = 0;
  for (let i = 0; i < Math.min(imageUrls.length, imageBlocks.length); i++) {
    const url = imageUrls[i];
    const blockId = imageBlocks[i].block_id;

    try {
      const buffer = await downloadImage(url, maxBytes);
      const urlPath = new URL(url).pathname;
      const fileName = urlPath.split("/").pop() || `image_${i}.png`;
      const fileToken = await uploadImageToDocx(client, blockId, buffer, fileName);

      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: blockId },
        data: {
          replace_image: { token: fileToken },
        },
      });

      processed++;
    } catch (err) {
      console.error(`Failed to process image ${url}:`, err);
    }
  }

  return processed;
}

// ============ Actions ============

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32]);

async function readDoc(client: Lark.Client, docToken: string) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) throw new Error(contentRes.msg);

  const blocks = blocksRes.data?.items ?? [];
  const blockCounts: Record<string, number> = {};
  const structuredTypes: string[] = [];

  for (const b of blocks) {
    const type = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;

    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) {
      structuredTypes.push(name);
    }
  }

  let hint: string | undefined;
  if (structuredTypes.length > 0) {
    hint = `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`;
  }

  return {
    title: infoRes.data?.document?.title,
    content: contentRes.data?.content,
    revision_id: infoRes.data?.document?.revision_id,
    block_count: blocks.length,
    block_types: blockCounts,
    ...(hint && { hint }),
  };
}

async function createDoc(client: Lark.Client, title: string, folderToken?: string) {
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) throw new Error(res.msg);
  const doc = res.data?.document;
  return {
    document_id: doc?.document_id,
    title: doc?.title,
    url: `https://feishu.cn/docx/${doc?.document_id}`,
  };
}

// Maximum content length for a single API call (empirical value based on Feishu API limits)
const MAX_CONTENT_LENGTH = 50000; // ~50KB
const MAX_BLOCKS_PER_INSERT = 50; // Maximum blocks per insert API call

export async function writeDoc(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  maxBytes: number,
) {
  const deleted = await clearDocumentContent(client, docToken);

  // Check content length and warn if too long
  if (markdown.length > MAX_CONTENT_LENGTH) {
    console.warn(
      `[feishu_doc] Content length (${markdown.length}) exceeds recommended limit (${MAX_CONTENT_LENGTH}). May cause API errors.`,
    );
  }

  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    return { success: true, blocks_deleted: deleted, blocks_added: 0, images_processed: 0 };
  }

  // Reorder blocks according to firstLevelBlockIds to maintain correct document order.
  // The convertMarkdown API returns blocks in an unordered map; firstLevelBlockIds
  // provides the correct top-level ordering.
  const orderedBlocks = reorderBlocks(blocks, firstLevelBlockIds);
  const blockMap = buildBlockMap(blocks);

  // Insert blocks while preserving table content when possible.
  const {
    children: inserted,
    skipped,
    warnings,
  } = await insertBlocksPreservingTables(client, docToken, orderedBlocks, blockMap);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  const warningParts: string[] = [];
  if (skipped.length > 0) {
    warningParts.push(`Skipped unsupported block types: ${skipped.join(", ")}.`);
  }
  if (warnings.length > 0) {
    warningParts.push(...warnings);
  }

  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    ...(warningParts.length > 0 && {
      warning: warningParts.join(" "),
    }),
  };
}

/**
 * Insert blocks in batches to avoid API limits
 */
async function insertBlocksInBatches(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  parentBlockId?: string,
): Promise<{ children: any[]; skipped: string[] }> {
  const allInserted: any[] = [];
  const allSkipped: string[] = [];
  const blockId = parentBlockId ?? docToken;

  // Process blocks in batches
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_INSERT) {
    const batch = blocks.slice(i, i + MAX_BLOCKS_PER_INSERT);
    const { cleaned, skipped } = cleanBlocksForInsert(batch);

    allSkipped.push(...skipped);

    if (cleaned.length === 0) {
      continue;
    }

    try {
      const res = await createChildrenWithRetry(client, {
        path: { document_id: docToken, block_id: blockId },
        data: { children: cleaned },
      });

      if (res.code !== 0) {
        // If batch insert fails, try inserting one by one
        console.warn(`[feishu_doc] Batch insert failed: ${res.msg}. Trying individual inserts...`);
        for (const block of cleaned) {
          try {
            const singleRes = await createChildrenWithRetry(client, {
              path: { document_id: docToken, block_id: blockId },
              data: { children: [block] },
            });
            if (singleRes.code === 0) {
              allInserted.push(...(singleRes.data?.children ?? []));
            } else {
              console.error(`[feishu_doc] Failed to insert block: ${singleRes.msg}`);
            }
          } catch (err) {
            console.error(`[feishu_doc] Error inserting block:`, err);
          }
        }
      } else {
        allInserted.push(...(res.data?.children ?? []));
      }
    } catch (err) {
      console.error(`[feishu_doc] Error in batch insert:`, err);
      throw err;
    }
  }

  return { children: allInserted, skipped: [...new Set(allSkipped)] };
}

async function appendDoc(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  maxBytes: number,
) {
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    throw new Error("Content is empty");
  }

  // Reorder blocks according to firstLevelBlockIds (same fix as writeDoc)
  const orderedBlocks = reorderBlocks(blocks, firstLevelBlockIds);

  const blockMap = buildBlockMap(blocks);
  const {
    children: inserted,
    skipped,
    warnings,
  } = await insertBlocksPreservingTables(client, docToken, orderedBlocks, blockMap);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  const warningParts: string[] = [];
  if (skipped.length > 0) {
    warningParts.push(`Skipped unsupported block types: ${skipped.join(", ")}.`);
  }
  if (warnings.length > 0) {
    warningParts.push(...warnings);
  }

  return {
    success: true,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    block_ids: inserted.map((b: any) => b.block_id),
    ...(warningParts.length > 0 && {
      warning: warningParts.join(" "),
    }),
  };
}

async function updateBlock(
  client: Lark.Client,
  docToken: string,
  blockId: string,
  content: string,
) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (blockInfo.code !== 0) throw new Error(blockInfo.msg);

  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content } }],
      },
    },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return { success: true, block_id: blockId };
}

async function deleteBlock(client: Lark.Client, docToken: string, blockId: string) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (blockInfo.code !== 0) throw new Error(blockInfo.msg);

  const parentId = blockInfo.data?.block?.parent_id ?? docToken;

  const children = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId },
  });
  if (children.code !== 0) throw new Error(children.msg);

  const items = children.data?.items ?? [];
  const index = items.findIndex((item: any) => item.block_id === blockId);
  if (index === -1) throw new Error("Block not found");

  const res = await client.docx.documentBlockChildren.batchDelete({
    path: { document_id: docToken, block_id: parentId },
    data: { start_index: index, end_index: index + 1 },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return { success: true, deleted_block_id: blockId };
}

async function listBlocks(client: Lark.Client, docToken: string) {
  const res = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return {
    blocks: res.data?.items ?? [],
  };
}

async function getBlock(client: Lark.Client, docToken: string, blockId: string) {
  const res = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (res.code !== 0) throw new Error(res.msg);

  return {
    block: res.data?.block,
  };
}

async function listAppScopes(client: Lark.Client) {
  const res = await client.application.scope.list({});
  if (res.code !== 0) throw new Error(res.msg);

  const scopes = res.data?.scopes ?? [];
  const granted = scopes.filter((s) => s.grant_status === 1);
  const pending = scopes.filter((s) => s.grant_status !== 1);

  return {
    granted: granted.map((s) => ({ name: s.scope_name, type: s.scope_type })),
    pending: pending.map((s) => ({ name: s.scope_name, type: s.scope_type })),
    summary: `${granted.length} granted, ${pending.length} pending`,
  };
}

// ============ Tool Registration ============

export function registerFeishuDocTools(api: OpenClawPluginApi) {
  if (!api.config) {
    api.logger.debug?.("feishu_doc: No config available, skipping doc tools");
    return;
  }

  if (!hasFeishuToolEnabledForAnyAccount(api.config)) {
    api.logger.debug?.("feishu_doc: No Feishu accounts configured, skipping doc tools");
    return;
  }

  // Registration happens once; account selection happens per execute() call.
  const docEnabled = hasFeishuToolEnabledForAnyAccount(api.config, "doc");
  const scopesEnabled = hasFeishuToolEnabledForAnyAccount(api.config, "scopes");
  const registered: string[] = [];

  // Main document tool with action-based dispatch
  if (docEnabled) {
    api.registerTool(
      {
        name: "feishu_doc",
        label: "Feishu Doc",
        description:
          "Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block",
        parameters: FeishuDocSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDocParams;
          try {
            return await withFeishuToolClient({
              api,
              toolName: "feishu_doc",
              requiredTool: "doc",
              run: async ({ client, account }) => {
                const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;
                switch (p.action) {
                  case "read":
                    return json(await readDoc(client, p.doc_token));
                  case "write":
                    return json(await writeDoc(client, p.doc_token, p.content, mediaMaxBytes));
                  case "append":
                    return json(await appendDoc(client, p.doc_token, p.content, mediaMaxBytes));
                  case "create":
                    return json(await createDoc(client, p.title, p.folder_token));
                  case "list_blocks":
                    return json(await listBlocks(client, p.doc_token));
                  case "get_block":
                    return json(await getBlock(client, p.doc_token, p.block_id));
                  case "update_block":
                    return json(await updateBlock(client, p.doc_token, p.block_id, p.content));
                  case "delete_block":
                    return json(await deleteBlock(client, p.doc_token, p.block_id));
                  default:
                    return json({ error: `Unknown action: ${(p as any).action}` });
                }
              },
            });
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: "feishu_doc" },
    );
    registered.push("feishu_doc");
  }

  // Keep feishu_app_scopes as independent tool
  if (scopesEnabled) {
    api.registerTool(
      {
        name: "feishu_app_scopes",
        label: "Feishu App Scopes",
        description:
          "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await withFeishuToolClient({
              api,
              toolName: "feishu_app_scopes",
              requiredTool: "scopes",
              run: async ({ client }) => listAppScopes(client),
            });
            return json(result);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: "feishu_app_scopes" },
    );
    registered.push("feishu_app_scopes");
  }

  if (registered.length > 0) {
    api.logger.debug?.(`feishu_doc: Registered ${registered.join(", ")}`);
  }
}
