// Feishu document errors retain the actual installed SDK's HTTP response diagnostics.
import { createServer } from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerFeishuDocTools } from "./docx.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const config = {
  channels: {
    feishu: {
      enabled: true,
      appId: "loopback-document-app",
      appSecret: "loopback-document-placeholder", // pragma: allowlist secret
      tools: { doc: true },
    },
  },
};

async function createDocumentLoopback() {
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push({ method: request.method ?? "", path });
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/open-apis/auth/")) {
      response.end(
        JSON.stringify({ code: 0, tenant_access_token: "owned-test-token", expire: 3600 }),
      );
    } else if (path === "/open-apis/docx/v1/documents/blocks/convert") {
      response.writeHead(400);
      response.end(
        JSON.stringify({
          code: 99991672,
          msg: "Access denied. Required scope: docx:document.block:convert",
          error: { log_id: "owned-convert-log" },
        }),
      );
    } else if (path === "/open-apis/docx/v1/documents") {
      response.end(
        JSON.stringify({
          code: 0,
          data: { document: { document_id: "owned-document", title: "Owned document" } },
        }),
      );
    } else {
      response.writeHead(500).end(JSON.stringify({ code: 1, msg: "Unexpected fixture request" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing document loopback address");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  // SAFETY: The SDK owns this Axios instance and unwraps responses to its HttpInstance contract.
  const sdkHttp = Lark.defaultHttpInstance as Lark.HttpInstance;
  const loopbackHttp = Object.create(sdkHttp) as Lark.HttpInstance;
  loopbackHttp.request = (options) => {
    const upstream = new URL(options.url ?? "");
    const target = new URL(`${upstream.pathname}${upstream.search}`, origin);
    return sdkHttp.request({ ...options, url: target.href });
  };
  const client = new Lark.Client({
    appId: config.channels.feishu.appId,
    appSecret: config.channels.feishu.appSecret,
    domain: Lark.Domain.Feishu,
    httpInstance: loopbackHttp,
    disableTokenCache: true,
    loggerLevel: Lark.LoggerLevel.error,
  });
  vi.spyOn(client.logger, "error").mockImplementation(() => {});
  vi.spyOn(await import("./client.js"), "createFeishuClient").mockReturnValue(client);
  const harness = createToolFactoryHarness(config);
  registerFeishuDocTools(harness.api);
  return { requests, tool: harness.resolveTool("feishu_doc") };
}

describe("Feishu document errors over the installed Lark SDK", () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => vi.resetModules());

  it("retains conversion rejection code, message and request log identity", async () => {
    const fixture = await createDocumentLoopback();
    const result = await fixture.tool.execute("convert-rejection", {
      action: "append",
      doc_token: "owned-document",
      content: "One paragraph",
    });
    const error = String(result.details.error);
    expect(error).toContain("99991672");
    expect(error).toContain("docx:document.block:convert");
    expect(error).toContain("owned-convert-log");
    expect(fixture.requests.filter(({ path }) => !path.startsWith("/open-apis/auth/"))).toEqual([
      { method: "POST", path: "/open-apis/docx/v1/documents/blocks/convert" },
    ]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT") }],
    });
  });

  it("keeps successful SDK document creation and local input rejection unchanged", async () => {
    const fixture = await createDocumentLoopback();
    const rejected = await fixture.tool.execute("local-rejection", {
      action: "create",
      title: "Owned document",
      content: "Unsupported create content",
    });
    expect(rejected.details.error).toContain('call action "write"');
    expect(fixture.requests).toEqual([]);
    const created = await fixture.tool.execute("successful-create", {
      action: "create",
      title: "Owned document",
    });
    expect(created.details).toMatchObject({
      document_id: "owned-document",
      title: "Owned document",
    });
    expect(fixture.requests.filter(({ path }) => !path.startsWith("/open-apis/auth/"))).toEqual([
      { method: "POST", path: "/open-apis/docx/v1/documents" },
    ]);
  });
});
