import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const clientModule = await import("./client.js");
vi.spyOn(clientModule, "createFeishuClient").mockImplementation(() => createFeishuClientMock());
const { registerFeishuDocTools } = await import("./docx.js");

type Patch = Lark.Client["docx"]["documentBlock"]["patch"];
type PatchResponse = Awaited<ReturnType<Patch>>;
const block = { block_id: "table_reply", block_type: 31 };
const actions = [
  {
    action: "insert_table_row",
    fields: { row_index: 2 },
    data: { insert_table_row: { row_index: 2 } },
    counts: {},
  },
  {
    action: "insert_table_column",
    fields: { column_index: 3 },
    data: { insert_table_column: { column_index: 3 } },
    counts: {},
  },
  {
    action: "delete_table_rows",
    fields: { row_start: 2, row_count: 3 },
    data: { delete_table_rows: { row_start_index: 2, row_end_index: 5 } },
    counts: { rows_deleted: 3 },
  },
  {
    action: "delete_table_columns",
    fields: { column_start: 3, column_count: 2 },
    data: { delete_table_columns: { column_start_index: 3, column_end_index: 5 } },
    counts: { columns_deleted: 2 },
  },
  {
    action: "merge_table_cells",
    fields: { row_start: 1, row_end: 3, column_start: 2, column_end: 5 },
    data: {
      merge_table_cells: {
        row_start_index: 1,
        row_end_index: 3,
        column_start_index: 2,
        column_end_index: 5,
      },
    },
    counts: {},
  },
];

function createClient(domain: string | Lark.Domain = Lark.Domain.Feishu) {
  return new Lark.Client({
    appId: "loopback-table-app",
    appSecret: "loopback-table-placeholder", // pragma: allowlist secret
    domain,
    loggerLevel: Lark.LoggerLevel.error,
    disableTokenCache: true,
  });
}

function createTableCellClient() {
  const client = createClient();
  vi.spyOn(client.docx.documentBlock, "get").mockResolvedValue({
    code: 0,
    data: {
      block: {
        block_type: 31,
        table: { property: { row_size: 1, column_size: 1 }, cells: ["cell_existing"] },
      },
    },
  });
  return client;
}

function resolveTool(client: Lark.Client) {
  createFeishuClientMock.mockReturnValue(client);
  const harness = createToolFactoryHarness({
    channels: {
      feishu: { enabled: true, appId: "table-app", appSecret: "table-placeholder" }, // pragma: allowlist secret
    },
  });
  registerFeishuDocTools(harness.api);
  return harness.resolveTool("feishu_doc");
}

function paramsFor(sample: (typeof actions)[number]): Record<string, unknown> {
  return {
    action: sample.action,
    doc_token: "doc_table",
    block_id: "table_target",
    ...sample.fields,
  };
}

function expectResult(
  result: { details: Record<string, unknown> },
  details: Record<string, unknown>,
) {
  expect(result.details).toStrictEqual(details);
  const { content } = result as {
    details: Record<string, unknown>;
    content: Array<{ type: string; text: string }>;
  };
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe("text");
  expect(content[0]?.text).toContain(`\nSource: API\n---\n${JSON.stringify(details, null, 2)}\n`);
}

describe("registered feishu_doc table patches", () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });
  beforeEach(() => {
    createFeishuClientMock.mockReset();
  });

  it("preserves existing table cell content when replacement Markdown conversion fails", async () => {
    const client = createTableCellClient();
    vi.spyOn(client.docx.documentBlockChildren, "get").mockResolvedValue({
      code: 0,
      data: { items: [{ block_id: "text_existing", block_type: 2 }] },
    });
    const remove = vi
      .spyOn(client.docx.documentBlockChildren, "batchDelete")
      .mockResolvedValue({ code: 0 });
    vi.spyOn(client.docx.document, "convert").mockResolvedValue({
      code: 999,
      msg: "replacement Markdown rejected",
    });

    expectResult(
      await resolveTool(client).execute("replace-table-cell", {
        action: "write_table_cells",
        doc_token: "doc_table",
        table_block_id: "table_target",
        values: [["Replacement content"]],
      }),
      { error: "replacement Markdown rejected" },
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it("captures delete counts before PATCH settles", async () => {
    const sample = actions[2]!;
    const client = createClient();
    const response = createDeferred<PatchResponse>();
    const patch = vi.spyOn(client.docx.documentBlock, "patch").mockReturnValue(response.promise);
    const params = paramsFor(sample);
    const pending = resolveTool(client).execute("table-patch", params);
    expect(patch).toHaveBeenCalledExactlyOnceWith({
      path: { document_id: "doc_table", block_id: "table_target" },
      data: sample.data,
    });
    params.row_count = 99;
    response.resolve({ code: 0, data: { block, client_token: "table-client-token" } });
    expectResult(await pending, { success: true, rows_deleted: 3, block });
  });

  it("replaces cell content with sequential supported blocks in document order", async () => {
    const client = createTableCellClient();
    const first = { block_id: "first", block_type: 2 };
    const second = { block_id: "second", block_type: 2 };
    vi.spyOn(client.docx.document, "convert").mockResolvedValue({
      code: 0,
      data: {
        blocks: [
          second,
          { block_id: "table", block_type: 31 },
          first,
          { block_id: "cell", block_type: 32 },
        ],
        first_level_block_ids: ["first", "table", "cell", "second"],
      },
    });
    vi.spyOn(client.docx.documentBlockChildren, "get").mockResolvedValue({
      code: 0,
      data: { items: [{ block_id: "old_text", block_type: 2 }] },
    });
    const remove = vi
      .spyOn(client.docx.documentBlockChildren, "batchDelete")
      .mockResolvedValue({ code: 0 });
    const started = createDeferred<void>();
    const response =
      createDeferred<Awaited<ReturnType<Lark.Client["docx"]["documentBlockChildren"]["create"]>>>();
    const insert = vi
      .spyOn(client.docx.documentBlockChildren, "create")
      .mockResolvedValue({ code: 0 })
      .mockImplementationOnce(() => {
        started.resolve();
        return response.promise;
      });
    const pending = resolveTool(client).execute("replace-cell", {
      action: "write_table_cells",
      doc_token: "doc_table",
      table_block_id: "table_target",
      values: [["Replacement content"]],
    });
    await started.promise;
    try {
      expect(remove).toHaveBeenCalledExactlyOnceWith({
        path: { document_id: "doc_table", block_id: "cell_existing" },
        data: { start_index: 0, end_index: 1 },
      });
      expect(insert).toHaveBeenCalledExactlyOnceWith({
        path: { document_id: "doc_table", block_id: "cell_existing" },
        data: { children: [first] },
      });
    } finally {
      response.resolve({ code: 0 });
    }
    expectResult(await pending, {
      success: true,
      table_block_id: "table_target",
      cells_written: 1,
      table_size: { rows: 1, cols: 1 },
    });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(2, {
      path: { document_id: "doc_table", block_id: "cell_existing" },
      data: { children: [second] },
    });
  });

  it.each(["selected", "missing"])("deletes only the located block (%s)", async (blockId) => {
    const client = createClient();
    vi.spyOn(client.docx.documentBlock, "get").mockResolvedValue({
      code: 0,
      data: { block: { parent_id: "parent", block_type: 2 } },
    });
    vi.spyOn(client.docx.documentBlockChildren, "get").mockResolvedValue({
      code: 0,
      data: {
        items: [
          { block_id: "before", block_type: 2 },
          { block_id: "selected", block_type: 2 },
          { block_id: "after", block_type: 2 },
        ],
      },
    });
    const remove = vi
      .spyOn(client.docx.documentBlockChildren, "batchDelete")
      .mockResolvedValue({ code: 0 });
    const result = await resolveTool(client).execute("delete-block", {
      action: "delete_block",
      doc_token: "doc_table",
      block_id: blockId,
    });
    if (blockId === "missing") {
      expectResult(result, { error: "Block not found" });
      expect(remove).not.toHaveBeenCalled();
    } else {
      expectResult(result, { success: true, deleted_block_id: "selected" });
      expect(remove).toHaveBeenCalledExactlyOnceWith({
        path: { document_id: "doc_table", block_id: "parent" },
        data: { start_index: 1, end_index: 2 },
      });
    }
  });

  it.each([
    { label: "omitted", fields: {}, index: -1, end: 3, count: 1 },
    { label: "zero", fields: { value: 0 }, index: 0, end: 2, count: 0 },
  ])(
    "preserves $label defaults at the registered-tool boundary",
    async ({ fields, index, end, count }) => {
      const cases = [
        {
          action: "insert_table_row",
          field: "row_index",
          input: {},
          data: { insert_table_row: { row_index: index } },
          counts: {},
        },
        {
          action: "insert_table_column",
          field: "column_index",
          input: {},
          data: { insert_table_column: { column_index: index } },
          counts: {},
        },
        {
          action: "delete_table_rows",
          field: "row_count",
          input: { row_start: 2 },
          data: { delete_table_rows: { row_start_index: 2, row_end_index: end } },
          counts: { rows_deleted: count },
        },
        {
          action: "delete_table_columns",
          field: "column_count",
          input: { column_start: 2 },
          data: { delete_table_columns: { column_start_index: 2, column_end_index: end } },
          counts: { columns_deleted: count },
        },
      ];
      const client = createClient();
      const patch = vi.spyOn(client.docx.documentBlock, "patch").mockResolvedValue({ code: 0 });
      const tool = resolveTool(client);
      for (const sample of cases) {
        const result = await tool.execute("default-value", {
          action: sample.action,
          doc_token: "doc_table",
          block_id: "table_target",
          ...sample.input,
          ...(Object.hasOwn(fields, "value") ? { [sample.field]: fields.value } : {}),
        });
        expect(patch).toHaveBeenLastCalledWith({
          path: { document_id: "doc_table", block_id: "table_target" },
          data: sample.data,
        });
        expectResult(result, { success: true, ...sample.counts, block: undefined });
      }
      expect(patch).toHaveBeenCalledTimes(4);
    },
  );

  it("rejects missing API status before inspecting response data", async () => {
    const client = createClient();
    vi.spyOn(client.docx.documentBlock, "patch").mockResolvedValue({
      msg: "table denied",
      get data(): never {
        throw new Error("data read before code");
      },
    });
    expectResult(await resolveTool(client).execute("api-error", paramsFor(actions[0]!)), {
      error: "table denied",
    });
  });

  it.each(["throw", "reject"] as const)(
    "returns SDK %s failures as tool errors",
    async (failure) => {
      const client = createClient();
      vi.spyOn(client.docx.documentBlock, "patch").mockImplementation(() => {
        if (failure === "throw") {
          throw new Error("transport failed");
        }
        return Promise.reject(new Error("transport failed"));
      });
      expectResult(await resolveTool(client).execute("sdk-error", paramsFor(actions[0]!)), {
        error: "transport failed",
      });
    },
  );

  it("sends all five PATCH variants through the installed SDK to loopback HTTP", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> =
      [];
    let reply: PatchResponse = { code: 0, data: { block, client_token: "table-client-token" } };
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        requests.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(reply));
      })().catch(() => response.writeHead(500).end());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address() as AddressInfo;
      const tool = resolveTool(createClient(`http://127.0.0.1:${address.port}`));
      for (const sample of actions) {
        reply = { code: 0, data: { block, client_token: "table-client-token" } };
        expectResult(await tool.execute("http-patch", paramsFor(sample)), {
          success: true,
          ...sample.counts,
          block,
        });
        reply = { code: 999, msg: "loopback table denied" };
        expectResult(await tool.execute("http-error", paramsFor(sample)), {
          error: "loopback table denied",
        });
      }
      expect(requests).toEqual(
        actions.flatMap((sample) =>
          Array.from({ length: 2 }, () => ({
            method: "PATCH",
            url: "/open-apis/docx/v1/documents/doc_table/blocks/table_target",
            body: JSON.stringify(sample.data),
          })),
        ),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
