import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { FeishuDocSchema, type FeishuDocParams } from "./doc-schema.js";
import { BATCH_SIZE, insertBlocksInBatches } from "./docx-batch-insert.js";
import { updateColorText } from "./docx-color-text.js";
import { extractImageUrls, processImages, uploadImageAction } from "./docx-picture-ops.js";
import {
  insertTableRow,
  insertTableColumn,
  deleteTableRows,
  deleteTableColumns,
  mergeTableCells,
  cleanBlocksForDescendant,
} from "./docx-table-ops.js";
import { resolveToolsConfig } from "./tools-config.js";

// ============ Helpers ============

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
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

// ============ Core Functions ============

async function convertMarkdown(client: Lark.Client, markdown: string) {
  const res = await client.docx.document.convert({
    data: { content_type: "markdown", content: markdown },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? [],
  };
}

function sortBlocksByFirstLevel(blocks: any[], firstLevelIds: string[]): any[] {
  if (!firstLevelIds || firstLevelIds.length === 0) return blocks;
  const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean);
  const sortedIds = new Set(firstLevelIds);
  const remaining = blocks.filter((b) => !sortedIds.has(b.block_id));
  return [...sorted, ...remaining];
}

/**
 * Insert blocks using Descendant API (single request, <1000 blocks).
 * For larger documents, use insertBlocksInBatches from docx-batch-insert.ts.
 *
 * @param parentBlockId - Parent block to insert into (defaults to docToken = document root)
 * @param index - Position within parent's children (-1 = end, 0 = first)
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK block types */
async function insertBlocksWithDescendant(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  firstLevelBlockIds: string[],
  { parentBlockId = docToken, index = -1 }: { parentBlockId?: string; index?: number } = {},
): Promise<{ children: any[]; skipped: string[] }> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const descendants = cleanBlocksForDescendant(blocks);

  if (descendants.length === 0) {
    return { children: [], skipped: [] };
  }

  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: {
      children_id: firstLevelBlockIds,
      descendants,
      index,
    },
  });

  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }

  const children = res.data?.children ?? [];
  return { children, skipped: [] };
}

async function clearDocumentContent(client: Lark.Client, docToken: string) {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (existing.code !== 0) {
    throw new Error(existing.msg);
  }

  const childIds =
    existing.data?.items
      ?.filter((b) => b.parent_id === docToken && b.block_type !== 1)
      .map((b) => b.block_id) ?? [];

  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length },
    });
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
  }

  return childIds.length;
}

// ============ Actions ============

const STRUCTURED_BLOCK_TYPES = new Set([14, 18, 21, 23, 27, 30, 31, 32]);

async function readDoc(client: Lark.Client, docToken: string) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } }),
  ]);

  if (contentRes.code !== 0) {
    throw new Error(contentRes.msg);
  }

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
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const doc = res.data?.document;
  return {
    document_id: doc?.document_id,
    title: doc?.title,
    url: `https://feishu.cn/docx/${doc?.document_id}`,
  };
}

type Logger = { info?: (msg: string) => void };

async function writeDoc(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  maxBytes: number,
  logger?: Logger,
) {
  const deleted = await clearDocumentContent(client, docToken);

  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    return { success: true, blocks_deleted: deleted, blocks_added: 0, images_processed: 0 };
  }
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
  // Use batched insert for large documents (>1000 blocks)
  const { children: inserted } =
    blocks.length > BATCH_SIZE
      ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger)
      : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);

  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length > 0) {
    logger?.info?.(
      `feishu_doc: Inserted ${inserted.length} blocks, processing ${imageUrls.length} images...`,
    );
  }
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: blocks.length,
    images_processed: imagesProcessed,
  };
}

async function appendDoc(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  maxBytes: number,
  logger?: Logger,
) {
  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    throw new Error("Content is empty");
  }
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
  // Use batched insert for large documents (>1000 blocks)
  const { children: inserted } =
    blocks.length > BATCH_SIZE
      ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger)
      : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);

  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length > 0) {
    logger?.info?.(
      `feishu_doc: Inserted ${inserted.length} blocks, processing ${imageUrls.length} images...`,
    );
  }
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_added: blocks.length,
    images_processed: imagesProcessed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
    block_ids: inserted.map((b: any) => b.block_id),
  };
}

async function insertDoc(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  afterBlockId: string,
  maxBytes: number,
  logger?: Logger,
) {
  // Resolve parent block and insertion index
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: afterBlockId },
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }

  const parentId = blockInfo.data?.block?.parent_id ?? docToken;

  // Find afterBlockId's position within its parent's children
  const childrenRes = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId },
  });
  if (childrenRes.code !== 0) {
    throw new Error(childrenRes.msg);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
  const items: any[] = childrenRes.data?.items ?? [];
  const blockIndex = items.findIndex((item) => item.block_id === afterBlockId);
  // Insert immediately after the target block (blockIndex + 1), or at end if not found
  const insertIndex = blockIndex === -1 ? -1 : blockIndex + 1;

  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    throw new Error("Content is empty");
  }
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  logger?.info?.(
    `feishu_doc: Converted to ${blocks.length} blocks, inserting at index ${insertIndex}...`,
  );
  const { children: inserted } =
    blocks.length > BATCH_SIZE
      ? await insertBlocksInBatches(
          client,
          docToken,
          sortedBlocks,
          firstLevelBlockIds,
          logger,
          parentId,
          insertIndex,
        )
      : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds, {
          parentBlockId: parentId,
          index: insertIndex,
        });

  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length > 0) {
    logger?.info?.(
      `feishu_doc: Inserted ${inserted.length} blocks, processing ${imageUrls.length} images...`,
    );
  }
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_added: blocks.length,
    images_processed: imagesProcessed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
    block_ids: inserted.map((b: any) => b.block_id),
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
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }

  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content } }],
      },
    },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return { success: true, block_id: blockId };
}

async function deleteBlock(client: Lark.Client, docToken: string, blockId: string) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }

  const parentId = blockInfo.data?.block?.parent_id ?? docToken;

  const children = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId },
  });
  if (children.code !== 0) {
    throw new Error(children.msg);
  }

  const items = children.data?.items ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
  const index = items.findIndex((item: any) => item.block_id === blockId);
  if (index === -1) {
    throw new Error("Block not found");
  }

  const res = await client.docx.documentBlockChildren.batchDelete({
    path: { document_id: docToken, block_id: parentId },
    data: { start_index: index, end_index: index + 1 },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return { success: true, deleted_block_id: blockId };
}

async function listBlocks(client: Lark.Client, docToken: string) {
  const res = await client.docx.documentBlock.list({
    path: { document_id: docToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    blocks: res.data?.items ?? [],
  };
}

async function getBlock(client: Lark.Client, docToken: string, blockId: string) {
  const res = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

  return {
    block: res.data?.block,
  };
}

async function listAppScopes(client: Lark.Client) {
  const res = await client.application.scope.list({});
  if (res.code !== 0) {
    throw new Error(res.msg);
  }

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

  // Check if any account is configured
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_doc: No Feishu accounts configured, skipping doc tools");
    return;
  }

  // Use first account's config for tools configuration
  const firstAccount = accounts[0];
  const toolsCfg = resolveToolsConfig(firstAccount.config.tools);
  const mediaMaxBytes = (firstAccount.config?.mediaMaxMb ?? 30) * 1024 * 1024;

  // Helper to get client for the default account
  const getClient = () => createFeishuClient(firstAccount);
  const registered: string[] = [];

  // Main document tool with action-based dispatch
  if (toolsCfg.doc) {
    api.registerTool(
      {
        name: "feishu_doc",
        label: "Feishu Doc",
        description:
          "Feishu document operations. Actions: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, color_text, upload_image",
        parameters: FeishuDocSchema,
        async execute(_toolCallId, params) {
          const p = params as FeishuDocParams;
          try {
            const client = getClient();
            switch (p.action) {
              case "read":
                return json(await readDoc(client, p.doc_token));
              case "write":
                return json(
                  await writeDoc(client, p.doc_token, p.content, mediaMaxBytes, api.logger),
                );
              case "append":
                return json(
                  await appendDoc(client, p.doc_token, p.content, mediaMaxBytes, api.logger),
                );
              case "insert":
                return json(
                  await insertDoc(
                    client,
                    p.doc_token,
                    p.content,
                    p.after_block_id,
                    mediaMaxBytes,
                    api.logger,
                  ),
                );
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
              case "insert_table_row":
                return json(await insertTableRow(client, p.doc_token, p.block_id, p.row_index));
              case "insert_table_column":
                return json(
                  await insertTableColumn(client, p.doc_token, p.block_id, p.column_index),
                );
              case "delete_table_rows":
                return json(
                  await deleteTableRows(client, p.doc_token, p.block_id, p.row_start, p.row_count),
                );
              case "delete_table_columns":
                return json(
                  await deleteTableColumns(
                    client,
                    p.doc_token,
                    p.block_id,
                    p.column_start,
                    p.column_count,
                  ),
                );
              case "merge_table_cells":
                return json(
                  await mergeTableCells(
                    client,
                    p.doc_token,
                    p.block_id,
                    p.row_start,
                    p.row_end,
                    p.column_start,
                    p.column_end,
                  ),
                );
              case "color_text":
                return json(await updateColorText(client, p.doc_token, p.block_id, p.content));
              case "upload_image":
                return json(
                  await uploadImageAction(
                    client,
                    p.doc_token,
                    p.image,
                    p.file_name,
                    p.block_id,
                    mediaMaxBytes,
                  ),
                );
              default:
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exhaustive check fallback
                return json({ error: `Unknown action: ${(p as any).action}` });
            }
          } catch (err) {
            api.logger.error?.(
              `feishu_doc error: ${err instanceof Error ? err.message : String(err)}`,
            );
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      },
      { name: "feishu_doc" },
    );
    registered.push("feishu_doc");
  }

  // Keep feishu_app_scopes as independent tool
  if (toolsCfg.scopes) {
    api.registerTool(
      {
        name: "feishu_app_scopes",
        label: "Feishu App Scopes",
        description:
          "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await listAppScopes(getClient());
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
    api.logger.info?.(`feishu_doc: Registered ${registered.join(", ")}`);
  }
}
