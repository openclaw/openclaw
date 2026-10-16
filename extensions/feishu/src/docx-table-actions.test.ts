import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopbackHttp, createLoopbackServer } from "./feishu-loopback.test-support.js";
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
type Fields = Record<string, number>;
function tableCase(action: string, fields: Fields, patch = fields, counts: Fields = {}) {
  return { action, fields, data: { [action]: patch }, counts };
}
function insertCase(axis: string, index: number, fields = { [`${axis}_index`]: index }) {
  return tableCase(`insert_table_${axis}`, fields, { [`${axis}_index`]: index });
}
function deleteCase(axis: string, [start, count, end]: [number, number, number], fields?: Fields) {
  return tableCase(
    `delete_table_${axis}s`,
    fields ?? { [`${axis}_start`]: start, [`${axis}_count`]: count },
    { [`${axis}_start_index`]: start, [`${axis}_end_index`]: end },
    { [`${axis}s_deleted`]: count },
  );
}
const actions = [
  insertCase("row", 2),
  insertCase("column", 3),
  deleteCase("row", [2, 3, 5]),
  deleteCase("column", [3, 2, 5]),
  tableCase(
    "merge_table_cells",
    { row_start: 1, row_end: 3, column_start: 2, column_end: 5 },
    { row_start_index: 1, row_end_index: 3, column_start_index: 2, column_end_index: 5 },
  ),
];
const patchPath = { document_id: "doc_table", block_id: "table_target" };
const successfulPatch: PatchResponse = {
  code: 0,
  data: { block, client_token: "table-client-token" },
};

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
    doc_token: patchPath.document_id,
    block_id: patchPath.block_id,
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
    expect(patch).toHaveBeenCalledExactlyOnceWith({ path: patchPath, data: sample.data });
    params.row_count = 99;
    response.resolve(successfulPatch);
    expectResult(await pending, { success: true, rows_deleted: 3, block });
  });

  it.each([
    { label: "omitted", fields: {}, index: -1, end: 3, count: 1 },
    { label: "zero", fields: { value: 0 }, index: 0, end: 2, count: 0 },
  ])(
    "preserves $label defaults at the registered-tool boundary",
    async ({ fields, index, end, count }) => {
      const optional = (field: string): Record<string, number> =>
        Object.hasOwn(fields, "value") ? { [field]: fields.value! } : {};
      const cases = [
        insertCase("row", index, optional("row_index")),
        insertCase("column", index, optional("column_index")),
        deleteCase("row", [2, count, end], { row_start: 2, ...optional("row_count") }),
        deleteCase("column", [2, count, end], { column_start: 2, ...optional("column_count") }),
      ];
      const client = createClient();
      const patch = vi.spyOn(client.docx.documentBlock, "patch").mockResolvedValue({ code: 0 });
      const tool = resolveTool(client);
      for (const sample of cases) {
        const result = await tool.execute("default-value", paramsFor(sample));
        expect(patch).toHaveBeenLastCalledWith({ path: patchPath, data: sample.data });
        expectResult(result, { success: true, ...sample.counts, block: undefined });
      }
      expect(patch).toHaveBeenCalledTimes(4);
    },
  );

  it.each(["missing status", "SDK throw", "SDK reject"])(
    "returns %s as a tool error without inspecting invalid data",
    async (failure) => {
      const client = createClient();
      vi.spyOn(client.docx.documentBlock, "patch").mockImplementation(() => {
        if (failure === "SDK throw") {
          throw new Error("transport failed");
        }
        if (failure === "SDK reject") {
          return Promise.reject(new Error("transport failed"));
        }
        return Promise.resolve({
          msg: "table denied",
          get data(): never {
            throw new Error("data read before code");
          },
        });
      });
      expectResult(await resolveTool(client).execute("api-error", paramsFor(actions[0]!)), {
        error: failure === "missing status" ? "table denied" : "transport failed",
      });
    },
  );

  it("sends all five PATCH variants through the installed SDK to loopback HTTP", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: string }> =
      [];
    let reply: PatchResponse = successfulPatch;
    const server = createLoopbackServer(({ method, url, rawBody }) => {
      requests.push({ method, url: `${url.pathname}${url.search}`, body: rawBody });
      return reply;
    });
    const tool = resolveTool(createClient(await createLoopbackHttp(server)));
    for (const sample of actions) {
      reply = successfulPatch;
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
  });
});
