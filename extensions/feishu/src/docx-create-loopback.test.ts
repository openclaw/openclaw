// Feishu tests prove the document create contract through the real Lark SDK.
import type { Server } from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createLoopbackHttp, createLoopbackServer } from "./feishu-loopback.test-support.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const clientModule = await import("./client.js");
const runtimeModule = await import("./runtime.js");

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
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockReturnValue({
  config: { mediaMaxMb: 30 },
} as ReturnType<typeof toolAccountModule.resolveFeishuToolAccount>);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockReturnValue({
  channel: { media: { readRemoteMediaBuffer: readRemoteMediaBufferMock } },
} as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>);

const { registerFeishuDocTools } = await import("./docx.js");

const ok = (data: unknown) => ({ code: 0, data });

async function resolveLoopbackTool(server: Server, context: Record<string, unknown> = {}) {
  const loopbackHttp = await createLoopbackHttp(server);
  createFeishuClientMock.mockReturnValue(
    new Lark.Client({
      appId: "loopback-test-app",
      appSecret: "loopback-test-placeholder", // pragma: allowlist secret
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
      disableTokenCache: true,
      httpInstance: loopbackHttp,
    }),
  );
  const harness = createToolFactoryHarness({
    channels: { feishu: { enabled: true, appId: "app_id", appSecret: "app_secret" } },
  });
  registerFeishuDocTools(harness.api);
  return harness.resolveTool("feishu_doc", context);
}

describe("feishu_doc contract over the real Lark SDK", () => {
  afterAll(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: Buffer.from("loopback image", "utf8"),
      fileName: "loopback.png",
    });
  });

  it("rejects create content before HTTP and supports the create-then-write API workflow", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const blocks = [{ block_type: 2, block_id: "body_loopback" }];
    const server = createLoopbackServer(({ method, path, rawBody }) => {
      requests.push({ method, path, ...(rawBody ? { body: JSON.parse(rawBody) as unknown } : {}) });
      switch (`${method} ${path}`) {
        case "POST /open-apis/docx/v1/documents":
          return ok({ document: { document_id: "doc_loopback", title: "Loopback Doc" } });
        case "POST /open-apis/docx/v1/documents/blocks/convert":
          return ok({ blocks, first_level_block_ids: ["body_loopback"] });
        case "GET /open-apis/docx/v1/documents/doc_loopback/blocks":
          return ok({ items: [] });
        case "POST /open-apis/docx/v1/documents/doc_loopback/blocks/doc_loopback/descendant":
          return ok({ children: blocks });
      }
    });

    const tool = await resolveLoopbackTool(server);
    const markdown = "# Hello\n\nBody content here";

    const rejected = await tool.execute("reject-create", {
      action: "create",
      title: "Loopback Doc",
      content: markdown,
    });
    expect(rejected.details.error).toContain('call action "write"');
    expect(createFeishuClientMock).not.toHaveBeenCalled();
    expect(requests).toEqual([]);

    const created = await tool.execute("create-document", {
      action: "create",
      title: "Loopback Doc",
    });
    expect(created.details).toMatchObject({ document_id: "doc_loopback" });
    const written = await tool.execute("write-document", {
      action: "write",
      doc_token: created.details.document_id,
      content: markdown,
    });

    expect(written.details).toMatchObject({ success: true, blocks_added: 1 });
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/open-apis/docx/v1/documents",
        body: { title: "Loopback Doc" },
      },
      {
        method: "POST",
        path: "/open-apis/docx/v1/documents/blocks/convert",
        body: { content_type: "markdown", content: markdown },
      },
      { method: "GET", path: "/open-apis/docx/v1/documents/doc_loopback/blocks" },
      {
        method: "POST",
        path: "/open-apis/docx/v1/documents/doc_loopback/blocks/doc_loopback/descendant",
        body: expect.objectContaining({ children_id: ["body_loopback"] }),
      },
    ]);
  });

  it.each([
    {
      description: "a repeated page token",
      pageToken: "repeated-token",
      expectedPageTokens: [null, "repeated-token"],
      expectedError:
        'Feishu document children pagination repeated token for parent block "parent_loopback"',
    },
    {
      description: "no next page token",
      pageToken: undefined,
      expectedPageTokens: [null],
      expectedError:
        'Feishu document children pagination is missing its next page token for parent block "parent_loopback"',
    },
  ])(
    "stops insert pagination when the SDK returns $description",
    async ({ pageToken, expectedPageTokens, expectedError }) => {
      const pageTokens: Array<string | null> = [];
      const block = { block_id: "after_loopback", parent_id: "parent_loopback", block_type: 2 };
      const server = createLoopbackServer(({ method, path, url }) => {
        if (method !== "GET") {
          return;
        }
        if (path === "/open-apis/docx/v1/documents/doc_loopback/blocks/after_loopback") {
          return ok({ block });
        }
        if (path === "/open-apis/docx/v1/documents/doc_loopback/blocks/parent_loopback/children") {
          pageTokens.push(url.searchParams.get("page_token"));
          if (pageTokens.length > 2) {
            return { code: 1, msg: "unexpected third pagination request" };
          }
          return ok({
            items: [block],
            has_more: true,
            ...(pageToken ? { page_token: pageToken } : {}),
          });
        }
      });

      const tool = await resolveLoopbackTool(server);
      const result = await tool.execute("insert-document", {
        action: "insert",
        doc_token: "doc_loopback",
        after_block_id: "after_loopback",
        content: "Body content",
      });

      expect(result.details.error).toContain(expectedError);
      expect(pageTokens).toEqual(expectedPageTokens);
    },
  );

  it("reports fulfilled nonzero image and permission responses as partial failures", async () => {
    const requests: Array<{ method: string; path: string; body?: string }> = [];
    const patchResponses = [
      { code: 230001, msg: "replace rejected" },
      { code: 0, data: { block: { block_id: "image_two", block_type: 27 } } },
    ];
    const blocks = ["image_one", "image_two"].map((block_id) => ({ block_type: 27, block_id }));
    const server = createLoopbackServer(({ method, path, rawBody }) => {
      requests.push({ method, path, ...(rawBody ? { body: rawBody } : {}) });
      switch (`${method} ${path}`) {
        case "POST /open-apis/docx/v1/documents": {
          const title = (JSON.parse(rawBody) as { title?: string }).title;
          return ok({
            document: {
              document_id: title === "Permission OK" ? "doc_permission_ok" : "doc_permission_no",
              title,
            },
          });
        }
        case "POST /open-apis/drive/v1/permissions/doc_permission_ok/members":
          return ok({ member: { member_id: "ou_requester" } });
        case "POST /open-apis/drive/v1/permissions/doc_permission_no/members":
          return { code: 999, msg: "grant denied" };
        case "POST /open-apis/docx/v1/documents/blocks/convert":
          return ok({ blocks, first_level_block_ids: ["image_one", "image_two"] });
        case "GET /open-apis/docx/v1/documents/doc_images/blocks":
          return ok({ items: [] });
        case "POST /open-apis/docx/v1/documents/doc_images/blocks/doc_images/descendant":
          return ok({ children: blocks });
        case "POST /open-apis/drive/v1/medias/upload_all":
          return ok({ file_token: `file_${requests.length}` });
      }
      if (
        method === "PATCH" &&
        path.startsWith("/open-apis/docx/v1/documents/doc_images/blocks/image_")
      ) {
        return patchResponses.shift();
      }
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => consoleErrorSpy.mockRestore());
    const tool = await resolveLoopbackTool(server, {
      messageChannel: "feishu",
      requesterSenderId: "ou_requester",
    });

    const permissionOk = await tool.execute("permission-ok", {
      action: "create",
      title: "Permission OK",
    });
    expect(JSON.stringify(permissionOk.details)).toBe(
      '{"document_id":"doc_permission_ok","title":"Permission OK","url":"https://feishu.cn/docx/doc_permission_ok","requester_permission_added":true,"requester_open_id":"ou_requester","requester_perm_type":"edit"}',
    );

    const permissionDenied = await tool.execute("permission-denied", {
      action: "create",
      title: "Permission Denied",
    });
    expect
      .soft(JSON.stringify(permissionDenied.details))
      .toBe(
        '{"document_id":"doc_permission_no","title":"Permission Denied","url":"https://feishu.cn/docx/doc_permission_no","requester_permission_added":false,"requester_open_id":"ou_requester","requester_perm_type":"edit","requester_permission_error":"grant denied"}',
      );

    const imageWrite = await tool.execute("image-write", {
      action: "write",
      doc_token: "doc_images",
      content: "![one](https://cdn.test/one.png)\n![two](https://cdn.test/two.png)",
    });
    expect
      .soft(JSON.stringify(imageWrite.details))
      .toBe('{"success":true,"blocks_deleted":0,"blocks_added":2,"images_processed":1}');
    expect(readRemoteMediaBufferMock).toHaveBeenCalledTimes(2);
    expect(
      requests.filter((request) => request.method === "PATCH").map((request) => request.path),
    ).toEqual([
      "/open-apis/docx/v1/documents/doc_images/blocks/image_one",
      "/open-apis/docx/v1/documents/doc_images/blocks/image_two",
    ]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to process image https://cdn.test/one.png:",
      expect.objectContaining({ message: "replace rejected" }),
    );
    const permissionBody = '{"member_type":"openid","member_id":"ou_requester","perm":"edit"}';
    expect(
      requests
        .filter((request) => request.path.includes("/permissions/"))
        .map((request) => request.body),
    ).toEqual([permissionBody, permissionBody]);
  });
});
