import type * as Lark from "@larksuiteoapi/node-sdk";
import { readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { cleanBlocksForDescendant } from "./docx-table-ops.js";
import type { FeishuDocxBlock, FeishuDocxBlockChild } from "./docx-types.js";

export const BATCH_SIZE = 1000; // Feishu API limit per request

type Logger = { info?: (msg: string) => void };

type DocxDescendantCreatePayload = NonNullable<
  Parameters<Lark.Client["docx"]["documentBlockDescendant"]["create"]>[0]
>;
type DocxDescendantCreateBlock = NonNullable<
  NonNullable<DocxDescendantCreatePayload["data"]>["descendants"]
>[number];

function normalizeChildIds(children: string[] | string | undefined): string[] | undefined {
  if (Array.isArray(children)) {
    return children;
  }
  const child = readStringValue(children);
  return child ? [child] : undefined;
}

function toDescendantBlock(block: FeishuDocxBlock): DocxDescendantCreateBlock {
  const children = normalizeChildIds(block.children);
  return {
    ...block,
    ...(children ? { children } : {}),
  } as DocxDescendantCreateBlock;
}

function collectDescendants(
  blockMap: Map<string, FeishuDocxBlock>,
  rootId: string,
): FeishuDocxBlock[] {
  const result: FeishuDocxBlock[] = [];
  const visited = new Set<string>();

  function collect(blockId: string) {
    if (visited.has(blockId)) {
      return;
    }
    visited.add(blockId);

    const block = blockMap.get(blockId);
    if (!block) {
      return;
    }

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

async function insertBatch(
  client: Lark.Client,
  docToken: string,
  blocks: FeishuDocxBlock[],
  firstLevelBlockIds: string[],
  parentBlockId: string = docToken,
  index = -1,
): Promise<FeishuDocxBlockChild[]> {
  const descendants = cleanBlocksForDescendant(blocks);

  if (descendants.length === 0) {
    return [];
  }

  const res = await client.docx.documentBlockDescendant.create({
    path: { document_id: docToken, block_id: parentBlockId },
    data: {
      children_id: firstLevelBlockIds,
      descendants: descendants.map(toDescendantBlock),
      index,
    },
  });

  if (res.code !== 0) {
    throw new Error(`${res.msg} (code: ${res.code})`);
  }

  return res.data?.children ?? [];
}

// Keep each root's descendants in one request, bounded by the API's 1000-block limit.
export async function insertBlocksInBatches(
  client: Lark.Client,
  docToken: string,
  blocks: FeishuDocxBlock[],
  firstLevelBlockIds: string[],
  logger?: Logger,
  parentBlockId: string = docToken,
  startIndex = -1,
): Promise<{ children: FeishuDocxBlockChild[]; skipped: string[] }> {
  const allChildren: FeishuDocxBlockChild[] = [];

  const batches: Array<{ firstLevelIds: string[]; blocks: FeishuDocxBlock[] }> = [];
  let currentBatch: { firstLevelIds: string[]; blocks: FeishuDocxBlock[] } = {
    firstLevelIds: [],
    blocks: [],
  };
  const usedBlockIds = new Set<string>();
  const blockMap = new Map<string, FeishuDocxBlock>();
  for (const block of blocks) {
    if (block.block_id) {
      blockMap.set(block.block_id, block);
    }
  }

  for (const firstLevelId of firstLevelBlockIds) {
    const descendants = collectDescendants(blockMap, firstLevelId);
    const newBlocks = descendants.filter((b) => b.block_id && !usedBlockIds.has(b.block_id));

    // A single block whose subtree exceeds the API limit cannot be split
    // (a table or other compound block must be inserted atomically).
    if (newBlocks.length > BATCH_SIZE) {
      throw new Error(
        `Block "${firstLevelId}" has ${newBlocks.length} descendants, which exceeds the ` +
          `Feishu API limit of ${BATCH_SIZE} blocks per request. ` +
          `Please split the content into smaller sections.`,
      );
    }

    if (
      currentBatch.blocks.length + newBlocks.length > BATCH_SIZE &&
      currentBatch.blocks.length > 0
    ) {
      batches.push(currentBatch);
      currentBatch = { firstLevelIds: [], blocks: [] };
    }

    currentBatch.firstLevelIds.push(firstLevelId);
    for (const block of newBlocks) {
      currentBatch.blocks.push(block);
      if (block.block_id) {
        usedBlockIds.add(block.block_id);
      }
    }
  }

  if (currentBatch.blocks.length > 0) {
    batches.push(currentBatch);
  }

  let currentIndex = startIndex;
  for (const [i, batch] of batches.entries()) {
    logger?.info?.(
      `feishu_doc: Inserting batch ${i + 1}/${batches.length} (${batch.blocks.length} blocks)...`,
    );

    const children = await insertBatch(
      client,
      docToken,
      batch.blocks,
      batch.firstLevelIds,
      parentBlockId,
      currentIndex,
    );
    allChildren.push(...children);

    // -1 always appends; explicit indices advance by roots, not descendant count.
    if (currentIndex !== -1) {
      currentIndex += batch.firstLevelIds.length;
    }
  }

  return { children: allChildren, skipped: [] };
}
