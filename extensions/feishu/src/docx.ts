import { Readable } from "stream";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuDocSchema, type FeishuDocParams } from "./doc-schema.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount,
} from "./tool-account.js";

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
const UNSUPPORTED_CREATE_TYPES = new Set([31, 32]);

/** Clean blocks for insertion (remove unsupported types and read-only fields) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block types
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
      if (block.block_type === 31 && block.table?.merge_info) {
        const { merge_info: _merge_info, ...tableRest } = block.table;
        return { ...block, table: tableRest };
      }
      return block;
    });
  return { cleaned, skipped };
}

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

/* eslint-disable @typescript-eslint/no-explicit-any -- SDK block types */
async function insertBlocks(
  client: Lark.Client,
  docToken: string,
  blocks: any[],
  parentBlockId?: string,
): Promise<{ children: any[]; skipped: string[] }> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const { cleaned, skipped } = cleanBlocksForInsert(blocks);
  const blockId = parentBlockId ?? docToken;

  if (cleaned.length === 0) {
    return { children: [], skipped };
  }

  const res = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: blockId },
    data: { children: cleaned },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { children: res.data?.children ?? [], skipped };
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK stream type
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

/* eslint-disable @typescript-eslint/no-explicit-any -- SDK block types */
async function processImages(
  client: Lark.Client,
  docToken: string,
  markdown: string,
  insertedBlocks: any[],
  maxBytes: number,
): Promise<number> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const imageUrls = extractImageUrls(markdown);
  if (imageUrls.length === 0) {
    return 0;
  }

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

async function createDoc(
  client: Lark.Client,
  title: string,
  folderToken?: string,
  ownerOpenId?: string,
  ownerPermType: "view" | "edit" | "full_access" = "full_access",
) {
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken },
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const doc = res.data?.document;
  const docToken = doc?.document_id;
  let ownerPermissionAdded = false;

  // Auto add owner permission if ownerOpenId is provided
  if (docToken && ownerOpenId) {
    try {
      await client.drive.permissionMember.create({
        path: { token: docToken },
        params: { type: "docx", need_notification: false },
        data: {
          member_type: "openid",
          member_id: ownerOpenId,
          perm: ownerPermType,
        },
      });
      ownerPermissionAdded = true;
    } catch (err) {
      console.warn("Failed to add owner permission (non-critical):", err);
    }
  }

  return {
    document_id: docToken,
    title: doc?.title,
    url: `https://feishu.cn/docx/${docToken}`,
    ...(ownerOpenId &&
      ownerPermissionAdded && {
        owner_permission_added: true,
        owner_open_id: ownerOpenId,
        owner_perm_type: ownerPermType,
      }),
  };
}

async function writeDoc(client: Lark.Client, docToken: string, markdown: string, maxBytes: number) {
  const deleted = await clearDocumentContent(client, docToken);

  const { blocks, firstLevelBlockIds } = await convertMarkdown(client, markdown);
  if (blocks.length === 0) {
    return { success: true, blocks_deleted: deleted, blocks_added: 0, images_processed: 0 };
  }
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  const { children: inserted, skipped } = await insertBlocks(client, docToken, sortedBlocks);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    ...(skipped.length > 0 && {
      warning: `Skipped unsupported block types: ${skipped.join(", ")}. Tables are not supported via this API.`,
    }),
  };
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
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);

  const { children: inserted, skipped } = await insertBlocks(client, docToken, sortedBlocks);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);

  return {
    success: true,
    blocks_added: inserted.length,
    images_processed: imagesProcessed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
    block_ids: inserted.map((b: any) => b.block_id),
    ...(skipped.length > 0 && {
      warning: `Skipped unsupported block types: ${skipped.join(", ")}. Tables are not supported via this API.`,
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

  // Register if enabled on any account; account routing is resolved per execution.
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);

  const registered: string[] = [];
  type FeishuDocExecuteParams = FeishuDocParams & { accountId?: string };

  const getClient = (params: { accountId?: string } | undefined, defaultAccountId?: string) =>
    createFeishuToolClient({ api, executeParams: params, defaultAccountId });

  const getMediaMaxBytes = (
    params: { accountId?: string } | undefined,
    defaultAccountId?: string,
  ) =>
    (resolveFeishuToolAccount({ api, executeParams: params, defaultAccountId }).config
      ?.mediaMaxMb ?? 30) *
    1024 *
    1024;

  // Main document tool with action-based dispatch
  if (toolsCfg.doc) {
    api.registerTool(
      (ctx) => {
        const defaultAccountId = ctx.agentAccountId;
        return {
          name: "feishu_doc",
          label: "Feishu Doc",
          description:
            "Feishu document operations. Actions: read, write, append, create, list_blocks, get_block, update_block, delete_block",
          parameters: FeishuDocSchema,
          async execute(_toolCallId, params) {
            const p = params as FeishuDocExecuteParams;
            try {
              const client = getClient(p, defaultAccountId);
              switch (p.action) {
                case "read":
                  return json(await readDoc(client, p.doc_token));
                case "write":
                  return json(
                    await writeDoc(
                      client,
                      p.doc_token,
                      p.content,
                      getMediaMaxBytes(p, defaultAccountId),
                    ),
                  );
                case "append":
                  return json(
                    await appendDoc(
                      client,
                      p.doc_token,
                      p.content,
                      getMediaMaxBytes(p, defaultAccountId),
                    ),
                  );
                case "create":
                  return json(
                    await createDoc(
                      client,
                      p.title,
                      p.folder_token,
                      p.owner_open_id,
                      p.owner_perm_type,
                    ),
                  );
                case "list_blocks":
                  return json(await listBlocks(client, p.doc_token));
                case "get_block":
                  return json(await getBlock(client, p.doc_token, p.block_id));
                case "update_block":
                  return json(await updateBlock(client, p.doc_token, p.block_id, p.content));
                case "delete_block":
                  return json(await deleteBlock(client, p.doc_token, p.block_id));
                default: {
                  const exhaustiveCheck: never = p;
                  return json({ error: `Unknown action: ${String(exhaustiveCheck)}` });
                }
              }
            } catch (err) {
              return json({ error: err instanceof Error ? err.message : String(err) });
            }
          },
        };
      },
      { name: "feishu_doc" },
    );
    registered.push("feishu_doc");
  }

  // Keep feishu_app_scopes as independent tool
  if (toolsCfg.scopes) {
    api.registerTool(
      (ctx) => ({
        name: "feishu_app_scopes",
        label: "Feishu App Scopes",
        description:
          "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await listAppScopes(getClient(undefined, ctx.agentAccountId));
            return json(result);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        },
      }),
      { name: "feishu_app_scopes" },
    );
    registered.push("feishu_app_scopes");
  }

  if (registered.length > 0) {
    api.logger.info?.(`feishu_doc: Registered ${registered.join(", ")}`);
  }
}
