import type * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { BATCH_SIZE, insertBlocksInBatches } from "./docx-batch-insert.js";
import type { FeishuDocxBlock } from "./docx-types.js";

type DocxDescendantCreate = Lark.Client["docx"]["documentBlockDescendant"]["create"];
type DocxDescendantCreateParams = Parameters<DocxDescendantCreate>[0];
type DocxDescendantCreateResponse = Awaited<ReturnType<DocxDescendantCreate>>;

function createDocxDescendantClient(
  create: (params: DocxDescendantCreateParams) => Promise<DocxDescendantCreateResponse>,
): Pick<Lark.Client, "docx"> {
  return {
    docx: {
      documentBlockDescendant: {
        create,
      },
    },
  };
}

function createCountingIterable<T>(values: T[]) {
  let iterations = 0;
  return {
    values: {
      [Symbol.iterator]: function* () {
        iterations += 1;
        yield* values;
      },
    },
    getIterations: () => iterations,
  };
}

describe("insertBlocksInBatches", () => {
  it("builds the source block map once for large flat trees", async () => {
    const blockCount = BATCH_SIZE + 200;
    const blocks = Array.from({ length: blockCount }, (_, index) => ({
      block_id: `block_${index}`,
      block_type: 2,
    }));
    const counting = createCountingIterable(blocks);
    const createMock = vi.fn(async ({ data }: { data: { children_id: string[] } }) => ({
      code: 0,
      data: {
        children: data.children_id.map((id) => ({ block_id: id })),
      },
    }));
    const client = createDocxDescendantClient(createMock);

    const result = await insertBlocksInBatches(
      client,
      "doc_1",
      Array.from(counting.values),
      blocks.map((block) => block.block_id),
    );

    expect(counting.getIterations()).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]?.[0]?.data.children_id).toHaveLength(BATCH_SIZE);
    expect(createMock.mock.calls[1]?.[0]?.data.children_id).toHaveLength(200);
    expect(result.children).toHaveLength(blockCount);
  });

  it("keeps nested descendants grouped with their root blocks", async () => {
    const createMock = vi.fn(
      async ({
        data,
      }: {
        data: { children_id: string[]; descendants: Array<{ block_id: string }> };
      }) => ({
        code: 0,
        data: {
          children: data.children_id.map((id) => ({ block_id: id })),
        },
      }),
    );
    const client = createDocxDescendantClient(createMock);
    const blocks: FeishuDocxBlock[] = [
      { block_id: "root_a", block_type: 1, children: ["child_a"] },
      { block_id: "child_a", block_type: 2 },
      { block_id: "root_b", block_type: 1, children: ["child_b"] },
      { block_id: "child_b", block_type: 2 },
    ];

    await insertBlocksInBatches(client, "doc_1", blocks, ["root_a", "root_b"]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]?.data.children_id).toEqual(["root_a", "root_b"]);
    expect(
      createMock.mock.calls[0]?.[0]?.data.descendants.map(
        (block: { block_id: string }) => block.block_id,
      ),
    ).toEqual(["root_a", "child_a", "root_b", "child_b"]);
  });
});
