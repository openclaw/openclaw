import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { basename } from "node:path";
import { Type } from "@sinclair/typebox";
import { listEnabledFeishuAccounts } from "./accounts.js";
import { FeishuDocSchema } from "./doc-schema.js";
import { BATCH_SIZE, insertBlocksInBatches } from "./docx-batch-insert.js";
import { updateColorText } from "./docx-color-text.js";
import {
  cleanBlocksForDescendant,
  insertTableRow,
  insertTableColumn,
  deleteTableRows,
  deleteTableColumns,
  mergeTableCells
} from "./docx-table-ops.js";
import { getFeishuRuntime } from "./runtime.js";
import {
  createFeishuToolClient,
  resolveAnyEnabledFeishuToolsConfig,
  resolveFeishuToolAccount
} from "./tool-account.js";
function json(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    details: data
  };
}
function extractImageUrls(markdown) {
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  const urls = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const url = match[1].trim();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      urls.push(url);
    }
  }
  return urls;
}
const BLOCK_TYPE_NAMES = {
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
  32: "TableCell"
};
const UNSUPPORTED_CREATE_TYPES = /* @__PURE__ */ new Set([31, 32]);
function cleanBlocksForInsert(blocks) {
  const skipped = [];
  const cleaned = blocks.filter((block) => {
    if (UNSUPPORTED_CREATE_TYPES.has(block.block_type)) {
      const typeName = BLOCK_TYPE_NAMES[block.block_type] || `type_${block.block_type}`;
      skipped.push(typeName);
      return false;
    }
    return true;
  }).map((block) => {
    if (block.block_type === 31 && block.table?.merge_info) {
      const { merge_info: _merge_info, ...tableRest } = block.table;
      return { ...block, table: tableRest };
    }
    return block;
  });
  return { cleaned, skipped };
}
const MAX_BLOCKS_PER_INSERT = 50;
const MAX_CONVERT_RETRY_DEPTH = 8;
async function convertMarkdown(client, markdown) {
  const res = await client.docx.document.convert({
    data: { content_type: "markdown", content: markdown }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    blocks: res.data?.blocks ?? [],
    firstLevelBlockIds: res.data?.first_level_block_ids ?? []
  };
}
function sortBlocksByFirstLevel(blocks, firstLevelIds) {
  if (!firstLevelIds || firstLevelIds.length === 0) return blocks;
  const sorted = firstLevelIds.map((id) => blocks.find((b) => b.block_id === id)).filter(Boolean);
  const sortedIds = new Set(firstLevelIds);
  const remaining = blocks.filter((b) => !sortedIds.has(b.block_id));
  return [...sorted, ...remaining];
}
async function insertBlocks(client, docToken, blocks, parentBlockId, index) {
  const { cleaned, skipped } = cleanBlocksForInsert(blocks);
  const blockId = parentBlockId ?? docToken;
  if (cleaned.length === 0) {
    return { children: [], skipped };
  }
  const allInserted = [];
  for (const [offset, block] of cleaned.entries()) {
    const res = await client.docx.documentBlockChildren.create({
      path: { document_id: docToken, block_id: blockId },
      data: {
        children: [block],
        ...index !== void 0 ? { index: index + offset } : {}
      }
    });
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
    allInserted.push(...res.data?.children ?? []);
  }
  return { children: allInserted, skipped };
}
function splitMarkdownByHeadings(markdown) {
  const lines = markdown.split("\n");
  const chunks = [];
  let current = [];
  let inFencedBlock = false;
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
    }
    if (!inFencedBlock && /^#{1,2}\s/.test(line) && current.length > 0) {
      chunks.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}
function splitMarkdownBySize(markdown, maxChars) {
  if (markdown.length <= maxChars) {
    return [markdown];
  }
  const lines = markdown.split("\n");
  const chunks = [];
  let current = [];
  let currentLength = 0;
  let inFencedBlock = false;
  for (const line of lines) {
    if (/^(`{3,}|~{3,})/.test(line)) {
      inFencedBlock = !inFencedBlock;
    }
    const lineLength = line.length + 1;
    const wouldExceed = currentLength + lineLength > maxChars;
    if (current.length > 0 && wouldExceed && !inFencedBlock) {
      chunks.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += lineLength;
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  if (chunks.length > 1) {
    return chunks;
  }
  const midpoint = Math.floor(lines.length / 2);
  if (midpoint <= 0 || midpoint >= lines.length) {
    return [markdown];
  }
  return [lines.slice(0, midpoint).join("\n"), lines.slice(midpoint).join("\n")];
}
async function convertMarkdownWithFallback(client, markdown, depth = 0) {
  try {
    return await convertMarkdown(client, markdown);
  } catch (error) {
    if (depth >= MAX_CONVERT_RETRY_DEPTH || markdown.length < 2) {
      throw error;
    }
    const splitTarget = Math.max(256, Math.floor(markdown.length / 2));
    const chunks = splitMarkdownBySize(markdown, splitTarget);
    if (chunks.length <= 1) {
      throw error;
    }
    const blocks = [];
    const firstLevelBlockIds = [];
    for (const chunk of chunks) {
      const converted = await convertMarkdownWithFallback(client, chunk, depth + 1);
      blocks.push(...converted.blocks);
      firstLevelBlockIds.push(...converted.firstLevelBlockIds);
    }
    return { blocks, firstLevelBlockIds };
  }
}
async function chunkedConvertMarkdown(client, markdown) {
  const chunks = splitMarkdownByHeadings(markdown);
  const allBlocks = [];
  const allFirstLevelBlockIds = [];
  for (const chunk of chunks) {
    const { blocks, firstLevelBlockIds } = await convertMarkdownWithFallback(client, chunk);
    const sorted = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
    allBlocks.push(...sorted);
    allFirstLevelBlockIds.push(...firstLevelBlockIds);
  }
  return { blocks: allBlocks, firstLevelBlockIds: allFirstLevelBlockIds };
}
async function chunkedInsertBlocks(client, docToken, blocks, parentBlockId) {
  const allChildren = [];
  const allSkipped = [];
  for (let i = 0; i < blocks.length; i += MAX_BLOCKS_PER_INSERT) {
    const batch = blocks.slice(i, i + MAX_BLOCKS_PER_INSERT);
    const { children, skipped } = await insertBlocks(client, docToken, batch, parentBlockId);
    allChildren.push(...children);
    allSkipped.push(...skipped);
  }
  return { children: allChildren, skipped: allSkipped };
}
async function insertBlocksWithDescendant(client, docToken, blocks, firstLevelBlockIds, { parentBlockId = docToken, index = -1 } = {}) {
  const descendants = cleanBlocksForDescendant(blocks);
  if (descendants.length === 0) {
    return { children: [] };
  }
  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: { children_id: firstLevelBlockIds, descendants, index }
  });
  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }
  return { children: res.data?.children ?? [] };
}
async function clearDocumentContent(client, docToken) {
  const existing = await client.docx.documentBlock.list({
    path: { document_id: docToken }
  });
  if (existing.code !== 0) {
    throw new Error(existing.msg);
  }
  const childIds = existing.data?.items?.filter((b) => b.parent_id === docToken && b.block_type !== 1).map((b) => b.block_id) ?? [];
  if (childIds.length > 0) {
    const res = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: docToken },
      data: { start_index: 0, end_index: childIds.length }
    });
    if (res.code !== 0) {
      throw new Error(res.msg);
    }
  }
  return childIds.length;
}
async function uploadImageToDocx(client, blockId, imageBuffer, fileName, docToken) {
  const res = await client.drive.media.uploadAll({
    data: {
      file_name: fileName,
      parent_type: "docx_image",
      parent_node: blockId,
      size: imageBuffer.length,
      // Pass Buffer directly so form-data can calculate Content-Length correctly.
      // Readable.from() produces a stream with unknown length, causing Content-Length
      // mismatch that silently truncates uploads for images larger than ~1KB.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK file type
      file: imageBuffer,
      // Required when the document block belongs to a non-default datacenter:
      // tells the drive service which document the block belongs to for routing.
      // Per API docs: certain upload scenarios require the cloud document token.
      ...docToken ? { extra: JSON.stringify({ drive_route_token: docToken }) } : {}
    }
  });
  const fileToken = res?.file_token;
  if (!fileToken) {
    throw new Error("Image upload failed: no file_token returned");
  }
  return fileToken;
}
async function downloadImage(url, maxBytes) {
  const fetched = await getFeishuRuntime().channel.media.fetchRemoteMedia({ url, maxBytes });
  return fetched.buffer;
}
async function resolveUploadInput(url, filePath, maxBytes, explicitFileName, imageInput) {
  const inputSources = [url ? "url" : null, filePath ? "file_path" : null, imageInput ? "image" : null].filter(Boolean);
  if (inputSources.length > 1) {
    throw new Error(`Provide only one image source; got: ${inputSources.join(", ")}`);
  }
  if (imageInput?.startsWith("data:")) {
    const commaIdx = imageInput.indexOf(",");
    if (commaIdx === -1) {
      throw new Error("Invalid data URI: missing comma separator.");
    }
    const header = imageInput.slice(0, commaIdx);
    const data = imageInput.slice(commaIdx + 1);
    if (!header.includes(";base64")) {
      throw new Error(
        `Invalid data URI: missing ';base64' marker. Expected format: data:image/png;base64,<base64data>`
      );
    }
    const trimmedData = data.trim();
    if (trimmedData.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmedData)) {
      throw new Error(
        `Invalid data URI: base64 payload contains characters outside the standard alphabet.`
      );
    }
    const mimeMatch = header.match(/data:([^;]+)/);
    const ext = mimeMatch?.[1]?.split("/")[1] ?? "png";
    const estimatedBytes = Math.ceil(trimmedData.length * 3 / 4);
    if (estimatedBytes > maxBytes) {
      throw new Error(
        `Image data URI exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`
      );
    }
    const buffer2 = Buffer.from(trimmedData, "base64");
    return { buffer: buffer2, fileName: explicitFileName ?? `image.${ext}` };
  }
  if (imageInput) {
    const candidate = imageInput.startsWith("~") ? imageInput.replace(/^~/, homedir()) : imageInput;
    const unambiguousPath = imageInput.startsWith("~") || imageInput.startsWith("./") || imageInput.startsWith("../");
    const absolutePath = isAbsolute(imageInput);
    if (unambiguousPath || absolutePath && existsSync(candidate)) {
      const buffer2 = await fs.readFile(candidate);
      if (buffer2.length > maxBytes) {
        throw new Error(`Local file exceeds limit: ${buffer2.length} bytes > ${maxBytes} bytes`);
      }
      return { buffer: buffer2, fileName: explicitFileName ?? basename(candidate) };
    }
    if (absolutePath && !existsSync(candidate)) {
      throw new Error(
        `File not found: "${candidate}". If you intended to pass image binary data, use a data URI instead: data:image/jpeg;base64,...`
      );
    }
  }
  if (imageInput) {
    const trimmed = imageInput.trim();
    if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
      throw new Error(
        `Invalid base64: image input contains characters outside the standard base64 alphabet. Use a data URI (data:image/png;base64,...) or a local file path instead.`
      );
    }
    const estimatedBytes = Math.ceil(trimmed.length * 3 / 4);
    if (estimatedBytes > maxBytes) {
      throw new Error(
        `Base64 image exceeds limit: estimated ${estimatedBytes} bytes > ${maxBytes} bytes`
      );
    }
    const buffer2 = Buffer.from(trimmed, "base64");
    if (buffer2.length === 0) {
      throw new Error("Base64 image decoded to empty buffer; check the input.");
    }
    return { buffer: buffer2, fileName: explicitFileName ?? "image.png" };
  }
  if (!url && !filePath) {
    throw new Error("Either url, file_path, or image (base64/data URI) must be provided");
  }
  if (url && filePath) {
    throw new Error("Provide only one of url or file_path");
  }
  if (url) {
    const fetched = await getFeishuRuntime().channel.media.fetchRemoteMedia({ url, maxBytes });
    const urlPath = new URL(url).pathname;
    const guessed = urlPath.split("/").pop() || "upload.bin";
    return {
      buffer: fetched.buffer,
      fileName: explicitFileName || guessed
    };
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.length > maxBytes) {
    throw new Error(`Local file exceeds limit: ${buffer.length} bytes > ${maxBytes} bytes`);
  }
  return {
    buffer,
    fileName: explicitFileName || basename(filePath)
  };
}
async function processImages(client, docToken, markdown, insertedBlocks, maxBytes) {
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
      const fileToken = await uploadImageToDocx(client, blockId, buffer, fileName, docToken);
      await client.docx.documentBlock.patch({
        path: { document_id: docToken, block_id: blockId },
        data: {
          replace_image: { token: fileToken }
        }
      });
      processed++;
    } catch (err) {
      console.error(`Failed to process image ${url}:`, err);
    }
  }
  return processed;
}
async function uploadImageBlock(client, docToken, maxBytes, url, filePath, parentBlockId, filename, index, imageInput) {
  const insertRes = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: parentBlockId ?? docToken },
    params: { document_revision_id: -1 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type
    data: { children: [{ block_type: 27, image: {} }], index: index ?? -1 }
  });
  if (insertRes.code !== 0) {
    throw new Error(`Failed to create image block: ${insertRes.msg}`);
  }
  const imageBlockId = insertRes.data?.children?.find((b) => b.block_type === 27)?.block_id;
  if (!imageBlockId) {
    throw new Error("Failed to create image block");
  }
  const upload = await resolveUploadInput(url, filePath, maxBytes, filename, imageInput);
  const fileToken = await uploadImageToDocx(
    client,
    imageBlockId,
    upload.buffer,
    upload.fileName,
    docToken
    // drive_route_token for multi-datacenter routing
  );
  const patchRes = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: imageBlockId },
    data: { replace_image: { token: fileToken } }
  });
  if (patchRes.code !== 0) {
    throw new Error(patchRes.msg);
  }
  return {
    success: true,
    block_id: imageBlockId,
    file_token: fileToken,
    file_name: upload.fileName,
    size: upload.buffer.length
  };
}
async function uploadFileBlock(client, docToken, maxBytes, url, filePath, parentBlockId, filename) {
  const blockId = parentBlockId ?? docToken;
  const upload = await resolveUploadInput(url, filePath, maxBytes, filename);
  const placeholderMd = `[${upload.fileName}](https://example.com/placeholder)`;
  const converted = await convertMarkdown(client, placeholderMd);
  const sorted = sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds);
  const { children: inserted } = await insertBlocks(client, docToken, sorted, blockId);
  const placeholderBlock = inserted[0];
  if (!placeholderBlock?.block_id) {
    throw new Error("Failed to create placeholder block for file upload");
  }
  const parentId = placeholderBlock.parent_id ?? blockId;
  const childrenRes = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId }
  });
  if (childrenRes.code !== 0) {
    throw new Error(childrenRes.msg);
  }
  const items = childrenRes.data?.items ?? [];
  const placeholderIdx = items.findIndex(
    (item) => item.block_id === placeholderBlock.block_id
  );
  if (placeholderIdx >= 0) {
    const deleteRes = await client.docx.documentBlockChildren.batchDelete({
      path: { document_id: docToken, block_id: parentId },
      data: { start_index: placeholderIdx, end_index: placeholderIdx + 1 }
    });
    if (deleteRes.code !== 0) {
      throw new Error(deleteRes.msg);
    }
  }
  const fileRes = await client.drive.media.uploadAll({
    data: {
      file_name: upload.fileName,
      parent_type: "docx_file",
      parent_node: docToken,
      size: upload.buffer.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK file type
      file: upload.buffer
    }
  });
  const fileToken = fileRes?.file_token;
  if (!fileToken) {
    throw new Error("File upload failed: no file_token returned");
  }
  return {
    success: true,
    file_token: fileToken,
    file_name: upload.fileName,
    size: upload.buffer.length,
    note: "File uploaded to drive. Use the file_token to reference it. Direct file block creation is not supported by the Feishu API."
  };
}
const STRUCTURED_BLOCK_TYPES = /* @__PURE__ */ new Set([14, 18, 21, 23, 27, 30, 31, 32]);
async function readDoc(client, docToken) {
  const [contentRes, infoRes, blocksRes] = await Promise.all([
    client.docx.document.rawContent({ path: { document_id: docToken } }),
    client.docx.document.get({ path: { document_id: docToken } }),
    client.docx.documentBlock.list({ path: { document_id: docToken } })
  ]);
  if (contentRes.code !== 0) {
    throw new Error(contentRes.msg);
  }
  const blocks = blocksRes.data?.items ?? [];
  const blockCounts = {};
  const structuredTypes = [];
  for (const b of blocks) {
    const type = b.block_type ?? 0;
    const name = BLOCK_TYPE_NAMES[type] || `type_${type}`;
    blockCounts[name] = (blockCounts[name] || 0) + 1;
    if (STRUCTURED_BLOCK_TYPES.has(type) && !structuredTypes.includes(name)) {
      structuredTypes.push(name);
    }
  }
  let hint;
  if (structuredTypes.length > 0) {
    hint = `This document contains ${structuredTypes.join(", ")} which are NOT included in the plain text above. Use feishu_doc with action: "list_blocks" to get full content.`;
  }
  return {
    title: infoRes.data?.document?.title,
    content: contentRes.data?.content,
    revision_id: infoRes.data?.document?.revision_id,
    block_count: blocks.length,
    block_types: blockCounts,
    ...hint && { hint }
  };
}
async function createDoc(client, title, folderToken, options) {
  const res = await client.docx.document.create({
    data: { title, folder_token: folderToken }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const doc = res.data?.document;
  const docToken = doc?.document_id;
  if (!docToken) {
    throw new Error("Document creation succeeded but no document_id was returned");
  }
  const shouldGrantToRequester = options?.grantToRequester !== false;
  const requesterOpenId = options?.requesterOpenId?.trim();
  const requesterPermType = "edit";
  let requesterPermissionAdded = false;
  let requesterPermissionSkippedReason;
  let requesterPermissionError;
  if (shouldGrantToRequester) {
    if (!requesterOpenId) {
      requesterPermissionSkippedReason = "trusted requester identity unavailable";
    } else {
      try {
        await client.drive.permissionMember.create({
          path: { token: docToken },
          params: { type: "docx", need_notification: false },
          data: {
            member_type: "openid",
            member_id: requesterOpenId,
            perm: requesterPermType
          }
        });
        requesterPermissionAdded = true;
      } catch (err) {
        requesterPermissionError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return {
    document_id: docToken,
    title: doc?.title,
    url: `https://feishu.cn/docx/${docToken}`,
    ...shouldGrantToRequester && {
      requester_permission_added: requesterPermissionAdded,
      ...requesterOpenId && { requester_open_id: requesterOpenId },
      requester_perm_type: requesterPermType,
      ...requesterPermissionSkippedReason && {
        requester_permission_skipped_reason: requesterPermissionSkippedReason
      },
      ...requesterPermissionError && { requester_permission_error: requesterPermissionError }
    }
  };
}
async function writeDoc(client, docToken, markdown, maxBytes, logger) {
  const deleted = await clearDocumentContent(client, docToken);
  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
  if (blocks.length === 0) {
    return { success: true, blocks_deleted: deleted, blocks_added: 0, images_processed: 0 };
  }
  logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
  const { children: inserted } = blocks.length > BATCH_SIZE ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_deleted: deleted,
    blocks_added: blocks.length,
    images_processed: imagesProcessed
  };
}
async function appendDoc(client, docToken, markdown, maxBytes, logger) {
  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
  if (blocks.length === 0) {
    throw new Error("Content is empty");
  }
  logger?.info?.(`feishu_doc: Converted to ${blocks.length} blocks, inserting...`);
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
  const { children: inserted } = blocks.length > BATCH_SIZE ? await insertBlocksInBatches(client, docToken, sortedBlocks, firstLevelBlockIds, logger) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds);
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_added: blocks.length,
    images_processed: imagesProcessed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
    block_ids: inserted.map((b) => b.block_id)
  };
}
async function insertDoc(client, docToken, markdown, afterBlockId, maxBytes, logger) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: afterBlockId }
  });
  if (blockInfo.code !== 0) throw new Error(blockInfo.msg);
  const parentId = blockInfo.data?.block?.parent_id ?? docToken;
  const items = [];
  let pageToken;
  do {
    const childrenRes = await client.docx.documentBlockChildren.get({
      path: { document_id: docToken, block_id: parentId },
      params: pageToken ? { page_token: pageToken } : {}
    });
    if (childrenRes.code !== 0) throw new Error(childrenRes.msg);
    items.push(...childrenRes.data?.items ?? []);
    pageToken = childrenRes.data?.page_token ?? void 0;
  } while (pageToken);
  const blockIndex = items.findIndex((item) => item.block_id === afterBlockId);
  if (blockIndex === -1) {
    throw new Error(
      `after_block_id "${afterBlockId}" was not found among the children of parent block "${parentId}". Use list_blocks to verify the block ID.`
    );
  }
  const insertIndex = blockIndex + 1;
  logger?.info?.("feishu_doc: Converting markdown...");
  const { blocks, firstLevelBlockIds } = await chunkedConvertMarkdown(client, markdown);
  if (blocks.length === 0) throw new Error("Content is empty");
  const sortedBlocks = sortBlocksByFirstLevel(blocks, firstLevelBlockIds);
  logger?.info?.(
    `feishu_doc: Converted to ${blocks.length} blocks, inserting at index ${insertIndex}...`
  );
  const { children: inserted } = blocks.length > BATCH_SIZE ? await insertBlocksInBatches(
    client,
    docToken,
    sortedBlocks,
    firstLevelBlockIds,
    logger,
    parentId,
    insertIndex
  ) : await insertBlocksWithDescendant(client, docToken, sortedBlocks, firstLevelBlockIds, {
    parentBlockId: parentId,
    index: insertIndex
  });
  const imagesProcessed = await processImages(client, docToken, markdown, inserted, maxBytes);
  logger?.info?.(`feishu_doc: Done (${blocks.length} blocks, ${imagesProcessed} images)`);
  return {
    success: true,
    blocks_added: blocks.length,
    images_processed: imagesProcessed,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK block type
    block_ids: inserted.map((b) => b.block_id)
  };
}
async function createTable(client, docToken, rowSize, columnSize, parentBlockId, columnWidth) {
  if (columnWidth && columnWidth.length !== columnSize) {
    throw new Error("column_width length must equal column_size");
  }
  const blockId = parentBlockId ?? docToken;
  const res = await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: blockId },
    data: {
      children: [
        {
          block_type: 31,
          table: {
            property: {
              row_size: rowSize,
              column_size: columnSize,
              ...columnWidth && columnWidth.length > 0 ? { column_width: columnWidth } : {}
            }
          }
        }
      ]
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  const tableBlock = res.data?.children?.find((b) => b.block_type === 31);
  const cells = tableBlock?.children ?? [];
  return {
    success: true,
    table_block_id: tableBlock?.block_id,
    row_size: rowSize,
    column_size: columnSize,
    // row-major cell ids, if API returns them directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK return type
    table_cell_block_ids: cells.map((c) => c.block_id).filter(Boolean),
    raw_children_count: res.data?.children?.length ?? 0
  };
}
async function writeTableCells(client, docToken, tableBlockId, values) {
  if (!values.length || !values[0]?.length) {
    throw new Error("values must be a non-empty 2D array");
  }
  const tableRes = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: tableBlockId }
  });
  if (tableRes.code !== 0) {
    throw new Error(tableRes.msg);
  }
  const tableBlock = tableRes.data?.block;
  if (tableBlock?.block_type !== 31) {
    throw new Error("table_block_id is not a table block");
  }
  const tableData = tableBlock.table;
  const rows = tableData?.property?.row_size;
  const cols = tableData?.property?.column_size;
  const cellIds = tableData?.cells ?? [];
  if (!rows || !cols || !cellIds.length) {
    throw new Error(
      "Table cell IDs unavailable from table block. Use list_blocks/get_block and pass explicit cell block IDs if needed."
    );
  }
  const writeRows = Math.min(values.length, rows);
  let written = 0;
  for (let r = 0; r < writeRows; r++) {
    const rowValues = values[r] ?? [];
    const writeCols = Math.min(rowValues.length, cols);
    for (let c = 0; c < writeCols; c++) {
      const cellId = cellIds[r * cols + c];
      if (!cellId) continue;
      const childrenRes = await client.docx.documentBlockChildren.get({
        path: { document_id: docToken, block_id: cellId }
      });
      if (childrenRes.code !== 0) {
        throw new Error(childrenRes.msg);
      }
      const existingChildren = childrenRes.data?.items ?? [];
      if (existingChildren.length > 0) {
        const delRes = await client.docx.documentBlockChildren.batchDelete({
          path: { document_id: docToken, block_id: cellId },
          data: { start_index: 0, end_index: existingChildren.length }
        });
        if (delRes.code !== 0) {
          throw new Error(delRes.msg);
        }
      }
      const text = rowValues[c] ?? "";
      const converted = await convertMarkdown(client, text);
      const sorted = sortBlocksByFirstLevel(converted.blocks, converted.firstLevelBlockIds);
      if (sorted.length > 0) {
        await insertBlocks(client, docToken, sorted, cellId);
      }
      written++;
    }
  }
  return {
    success: true,
    table_block_id: tableBlockId,
    cells_written: written,
    table_size: { rows, cols }
  };
}
async function createTableWithValues(client, docToken, rowSize, columnSize, values, parentBlockId, columnWidth) {
  const created = await createTable(
    client,
    docToken,
    rowSize,
    columnSize,
    parentBlockId,
    columnWidth
  );
  const tableBlockId = created.table_block_id;
  if (!tableBlockId) {
    throw new Error("create_table succeeded but table_block_id is missing");
  }
  const written = await writeTableCells(client, docToken, tableBlockId, values);
  return {
    success: true,
    table_block_id: tableBlockId,
    row_size: rowSize,
    column_size: columnSize,
    cells_written: written.cells_written
  };
}
async function updateBlock(client, docToken, blockId, content) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId }
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }
  const res = await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: blockId },
    data: {
      update_text_elements: {
        elements: [{ text_run: { content } }]
      }
    }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, block_id: blockId };
}
async function deleteBlock(client, docToken, blockId) {
  const blockInfo = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId }
  });
  if (blockInfo.code !== 0) {
    throw new Error(blockInfo.msg);
  }
  const parentId = blockInfo.data?.block?.parent_id ?? docToken;
  const children = await client.docx.documentBlockChildren.get({
    path: { document_id: docToken, block_id: parentId }
  });
  if (children.code !== 0) {
    throw new Error(children.msg);
  }
  const items = children.data?.items ?? [];
  const index = items.findIndex((item) => item.block_id === blockId);
  if (index === -1) {
    throw new Error("Block not found");
  }
  const res = await client.docx.documentBlockChildren.batchDelete({
    path: { document_id: docToken, block_id: parentId },
    data: { start_index: index, end_index: index + 1 }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return { success: true, deleted_block_id: blockId };
}
async function listBlocks(client, docToken) {
  const res = await client.docx.documentBlock.list({
    path: { document_id: docToken }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    blocks: res.data?.items ?? []
  };
}
async function getBlock(client, docToken, blockId) {
  const res = await client.docx.documentBlock.get({
    path: { document_id: docToken, block_id: blockId }
  });
  if (res.code !== 0) {
    throw new Error(res.msg);
  }
  return {
    block: res.data?.block
  };
}
async function listAppScopes(client) {
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
    summary: `${granted.length} granted, ${pending.length} pending`
  };
}
function registerFeishuDocTools(api) {
  if (!api.config) {
    api.logger.debug?.("feishu_doc: No config available, skipping doc tools");
    return;
  }
  const accounts = listEnabledFeishuAccounts(api.config);
  if (accounts.length === 0) {
    api.logger.debug?.("feishu_doc: No Feishu accounts configured, skipping doc tools");
    return;
  }
  const toolsCfg = resolveAnyEnabledFeishuToolsConfig(accounts);
  const registered = [];
  const getClient = (params, defaultAccountId) => createFeishuToolClient({ api, executeParams: params, defaultAccountId });
  const getMediaMaxBytes = (params, defaultAccountId) => (resolveFeishuToolAccount({ api, executeParams: params, defaultAccountId }).config?.mediaMaxMb ?? 30) * 1024 * 1024;
  if (toolsCfg.doc) {
    api.registerTool(
      (ctx) => {
        const defaultAccountId = ctx.agentAccountId;
        const trustedRequesterOpenId = ctx.messageChannel === "feishu" ? ctx.requesterSenderId?.trim() || void 0 : void 0;
        return {
          name: "feishu_doc",
          label: "Feishu Doc",
          description: "Feishu document operations. Actions: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file, color_text",
          parameters: FeishuDocSchema,
          async execute(_toolCallId, params) {
            const p = params;
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
                      api.logger
                    )
                  );
                case "append":
                  return json(
                    await appendDoc(
                      client,
                      p.doc_token,
                      p.content,
                      getMediaMaxBytes(p, defaultAccountId),
                      api.logger
                    )
                  );
                case "insert":
                  return json(
                    await insertDoc(
                      client,
                      p.doc_token,
                      p.content,
                      p.after_block_id,
                      getMediaMaxBytes(p, defaultAccountId),
                      api.logger
                    )
                  );
                case "create":
                  return json(
                    await createDoc(client, p.title, p.folder_token, {
                      grantToRequester: p.grant_to_requester,
                      requesterOpenId: trustedRequesterOpenId
                    })
                  );
                case "list_blocks":
                  return json(await listBlocks(client, p.doc_token));
                case "get_block":
                  return json(await getBlock(client, p.doc_token, p.block_id));
                case "update_block":
                  return json(await updateBlock(client, p.doc_token, p.block_id, p.content));
                case "delete_block":
                  return json(await deleteBlock(client, p.doc_token, p.block_id));
                case "create_table":
                  return json(
                    await createTable(
                      client,
                      p.doc_token,
                      p.row_size,
                      p.column_size,
                      p.parent_block_id,
                      p.column_width
                    )
                  );
                case "write_table_cells":
                  return json(
                    await writeTableCells(client, p.doc_token, p.table_block_id, p.values)
                  );
                case "create_table_with_values":
                  return json(
                    await createTableWithValues(
                      client,
                      p.doc_token,
                      p.row_size,
                      p.column_size,
                      p.values,
                      p.parent_block_id,
                      p.column_width
                    )
                  );
                case "upload_image":
                  return json(
                    await uploadImageBlock(
                      client,
                      p.doc_token,
                      getMediaMaxBytes(p, defaultAccountId),
                      p.url,
                      p.file_path,
                      p.parent_block_id,
                      p.filename,
                      p.index,
                      p.image
                      // data URI or plain base64
                    )
                  );
                case "upload_file":
                  return json(
                    await uploadFileBlock(
                      client,
                      p.doc_token,
                      getMediaMaxBytes(p, defaultAccountId),
                      p.url,
                      p.file_path,
                      p.parent_block_id,
                      p.filename
                    )
                  );
                case "color_text":
                  return json(await updateColorText(client, p.doc_token, p.block_id, p.content));
                case "insert_table_row":
                  return json(await insertTableRow(client, p.doc_token, p.block_id, p.row_index));
                case "insert_table_column":
                  return json(
                    await insertTableColumn(client, p.doc_token, p.block_id, p.column_index)
                  );
                case "delete_table_rows":
                  return json(
                    await deleteTableRows(
                      client,
                      p.doc_token,
                      p.block_id,
                      p.row_start,
                      p.row_count
                    )
                  );
                case "delete_table_columns":
                  return json(
                    await deleteTableColumns(
                      client,
                      p.doc_token,
                      p.block_id,
                      p.column_start,
                      p.column_count
                    )
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
                      p.column_end
                    )
                  );
                default:
                  return json({ error: `Unknown action: ${p.action}` });
              }
            } catch (err) {
              return json({ error: err instanceof Error ? err.message : String(err) });
            }
          }
        };
      },
      { name: "feishu_doc" }
    );
    registered.push("feishu_doc");
  }
  if (toolsCfg.scopes) {
    api.registerTool(
      (ctx) => ({
        name: "feishu_app_scopes",
        label: "Feishu App Scopes",
        description: "List current app permissions (scopes). Use to debug permission issues or check available capabilities.",
        parameters: Type.Object({}),
        async execute() {
          try {
            const result = await listAppScopes(getClient(void 0, ctx.agentAccountId));
            return json(result);
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) });
          }
        }
      }),
      { name: "feishu_app_scopes" }
    );
    registered.push("feishu_app_scopes");
  }
  if (registered.length > 0) {
    api.logger.info?.(`feishu_doc: Registered ${registered.join(", ")}`);
  }
}
export {
  registerFeishuDocTools
};
