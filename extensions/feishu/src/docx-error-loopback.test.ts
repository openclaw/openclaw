import * as Lark from "@larksuiteoapi/node-sdk";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { registerFeishuDocTools } from "./docx.js";
import { createToolFactoryHarness, type ToolLike } from "./tool-factory-test-harness.js";

const credentials = {
  appId: "loopback-document-app",
  appSecret: "loopback-document-placeholder", // pragma: allowlist secret
};
const config = { channels: { feishu: { enabled: true, ...credentials, tools: { doc: true } } } };
const createParams = { action: "create", title: "Owned document" };
const document = { document_id: "owned-document", title: "Owned document" };

async function withDocumentLoopback(
  run: (execute: ToolLike["execute"], requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push(`${request.method ?? ""} ${path}`);
      const reply = (body: unknown, status = 200) =>
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      if (path.startsWith("/open-apis/auth/")) {
        reply({ code: 0, tenant_access_token: "owned-test-token", expire: 3600 });
      } else if (path === "/open-apis/docx/v1/documents/blocks/convert") {
        reply(
          {
            code: 99991672,
            msg: "Access denied. Required scope: docx:document.block:convert",
            error: { log_id: "owned-convert-log" },
          },
          400,
        );
      } else if (path === "/open-apis/docx/v1/documents") {
        reply({ code: 0, data: { document } });
      } else {
        reply({ code: 1, msg: "Unexpected fixture request" }, 500);
      }
    },
    async (origin) => {
      // SAFETY: The SDK owns this Axios instance and unwraps responses to its HttpInstance contract.
      const sdkHttp = Lark.defaultHttpInstance as Lark.HttpInstance;
      const loopbackHttp = Object.create(sdkHttp) as Lark.HttpInstance;
      loopbackHttp.request = (options) => {
        const upstream = new URL(options.url ?? "");
        return sdkHttp.request({
          ...options,
          url: `${origin}${upstream.pathname}${upstream.search}`,
        });
      };
      const client = new Lark.Client({
        ...credentials,
        domain: Lark.Domain.Feishu,
        httpInstance: loopbackHttp,
        disableTokenCache: true,
        loggerLevel: Lark.LoggerLevel.error,
      });
      vi.spyOn(client.logger, "error").mockImplementation(() => {});
      vi.spyOn(await import("./client.js"), "createFeishuClient").mockReturnValue(client);
      const harness = createToolFactoryHarness(config);
      registerFeishuDocTools(harness.api);
      await run(harness.resolveTool("feishu_doc").execute, requests);
    },
  );
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.resetModules());

it("retains conversion rejection code, message and request log identity", async () => {
  await withDocumentLoopback(async (execute, requests) => {
    const result = await execute("convert-rejection", {
      action: "append",
      doc_token: "owned-document",
      content: "One paragraph",
    });
    const error = String(result.details.error);
    for (const detail of ["99991672", "docx:document.block:convert", "owned-convert-log"]) {
      expect(error).toContain(detail);
    }
    expect(requests.filter((request) => !request.includes("/open-apis/auth/"))).toEqual([
      "POST /open-apis/docx/v1/documents/blocks/convert",
    ]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT") }],
    });
  });
});

it("keeps successful SDK document creation and local input rejection unchanged", async () => {
  await withDocumentLoopback(async (execute, requests) => {
    const rejected = await execute("local-rejection", {
      ...createParams,
      content: "Unsupported create content",
    });
    expect(rejected.details.error).toContain('call action "write"');
    expect(requests).toEqual([]);
    const created = await execute("successful-create", createParams);
    expect(created.details).toMatchObject(document);
    expect(requests.filter((request) => !request.includes("/open-apis/auth/"))).toEqual([
      "POST /open-apis/docx/v1/documents",
    ]);
  });
});
