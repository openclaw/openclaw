import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const clientModule = await import("./client.js");
vi.spyOn(clientModule, "createFeishuClient").mockImplementation(() => createFeishuClientMock());
vi.spyOn(toolAccountModule, "resolveAnyEnabledFeishuToolsConfig").mockReturnValue({
  doc: true,
  chat: false,
  wiki: false,
  drive: false,
  perm: false,
  scopes: false,
  bitable: false,
});
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

function createClient(httpInstance?: Lark.HttpInstance) {
  return new Lark.Client({
    appId: "loopback-table-app",
    appSecret: "loopback-table-placeholder", // pragma: allowlist secret
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.error,
    disableTokenCache: true,
    httpInstance,
  });
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
      const transport = Object.create(Lark.defaultHttpInstance) as Lark.HttpInstance;
      transport.request = async (options) => {
        const upstream = new URL(options.url ?? "");
        const target = new URL(
          `${upstream.pathname}${upstream.search}`,
          `http://127.0.0.1:${address.port}`,
        );
        const response = await fetch(target, {
          method: options.method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(options.data),
        });
        return response.json();
      };
      const tool = resolveTool(createClient(transport));
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
