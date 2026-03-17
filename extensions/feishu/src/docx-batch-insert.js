import { cleanBlocksForDescendant } from "./docx-table-ops.js";
const BATCH_SIZE = 1e3;
function collectDescendants(blockMap, rootId) {
  const result = [];
  const visited = /* @__PURE__ */ new Set();
  function collect(blockId) {
    if (visited.has(blockId)) return;
    visited.add(blockId);
    const block = blockMap.get(blockId);
    if (!block) return;
    result.push(block);
    const children = block.children;
    if (Array.isArray(children)) {
      for (const childId of children) {
        collect(childId);
      }
    } else if (typeof children === "string") {
      collect(children);
    }
  }
  collect(rootId);
  return result;
}
async function insertBatch(client, docToken, blocks, firstLevelBlockIds, parentBlockId = docToken, index = -1) {
  const descendants = cleanBlocksForDescendant(blocks);
  if (descendants.length === 0) {
    return [];
  }
  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: {
      children_id: firstLevelBlockIds,
      descendants,
      index
    }
  });
  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }
  return res.data?.children ?? [];
}
async function insertBlocksInBatches(client, docToken, blocks, firstLevelBlockIds, logger, parentBlockId = docToken, startIndex = -1) {
  const allChildren = [];
  const batches = [];
  let currentBatch = { firstLevelIds: [], blocks: [] };
  const usedBlockIds = /* @__PURE__ */ new Set();
  const blockMap = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    blockMap.set(block.block_id, block);
  }
  for (const firstLevelId of firstLevelBlockIds) {
    const descendants = collectDescendants(blockMap, firstLevelId);
    const newBlocks = descendants.filter((b) => !usedBlockIds.has(b.block_id));
    if (newBlocks.length > BATCH_SIZE) {
      throw new Error(
        `Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the Feishu API limit of ${BATCH_SIZE} blocks per request. Please split the content into smaller sections.`
      );
    }
    if (currentBatch.blocks.length + newBlocks.length > BATCH_SIZE && currentBatch.blocks.length > 0) {
      batches.push(currentBatch);
      currentBatch = { firstLevelIds: [], blocks: [] };
    }
    currentBatch.firstLevelIds.push(firstLevelId);
    for (const block of newBlocks) {
      currentBatch.blocks.push(block);
      usedBlockIds.add(block.block_id);
    }
  }
  if (currentBatch.blocks.length > 0) {
    batches.push(currentBatch);
  }
  let currentIndex = startIndex;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logger?.info?.(
      `feishu_doc: Inserting batch ${i + 1}/${batches.length} (${batch.blocks.length} blocks)...`
    );
    const children = await insertBatch(
      client,
      docToken,
      batch.blocks,
      batch.firstLevelIds,
      parentBlockId,
      currentIndex
    );
    allChildren.push(...children);
    if (currentIndex !== -1) {
      currentIndex += batch.firstLevelIds.length;
    }
  }
  return { children: allChildren, skipped: [] };
}
export {
  BATCH_SIZE,
  insertBlocksInBatches
};
