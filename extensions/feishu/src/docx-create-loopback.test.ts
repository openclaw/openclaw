import { createServer } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import * as Lark from "@larksuiteoapi/node-sdk";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());
const toolAccountModule = await import("./tool-account.js");
const clientModule = await import("./client.js");
const runtimeModule = await import("./runtime.js");

vi.spyOn(clientModule, "createFeishuClient").mockImplementation(() => createFeishuClientMock());
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockReturnValue({
  config: { mediaMaxMb: 30 },
} as ReturnType<typeof toolAccountModule.resolveFeishuToolAccount>);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockReturnValue({
  channel: { media: { readRemoteMediaBuffer: readRemoteMediaBufferMock } },
} as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>);

const { registerFeishuDocTools } = await import("./docx.js");

type Request = { method: string; path: string; body?: string };
const ok = (data: unknown) => ({ code: 0, data });
const docPath = "/open-apis/docx/v1/documents";
const block = (block_id: string, block_type = 2) => ({ block_id, block_type });

function serve(routes: Record<string, (request: Request, url: URL) => unknown>) {
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const rawBody = (await consumeBuffer(request)).toString("utf8");
      const received = {
        method: request.method ?? "",
        path: url.pathname,
        ...(rawBody ? { body: rawBody } : {}),
      };
      requests.push(received);
      const route = routes[`${received.method} ${received.path}`];
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(route(received, url)));
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  return { server, requests };
}

async function resolveLoopbackTool(
  server: ReturnType<typeof createServer>,
  context: Record<string, unknown> = {},
) {
  const port = await listenOnLoopback(server);
  onTestFinished(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  createFeishuClientMock.mockReturnValue(
    new Lark.Client({
      appId: "loopback-test-app",
      appSecret: "loopback-test-placeholder", // pragma: allowlist secret
      domain: `http://127.0.0.1:${port}`,
      loggerLevel: Lark.LoggerLevel.error,
      disableTokenCache: true,
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
    const { server, requests } = serve({
      [`POST ${docPath}`]: () =>
        ok({ document: { document_id: "doc_loopback", title: "Loopback Doc" } }),
      [`POST ${docPath}/blocks/convert`]: () =>
        ok({ blocks: [block("body_loopback")], first_level_block_ids: ["body_loopback"] }),
      [`GET ${docPath}/doc_loopback/blocks`]: () => ok({ items: [] }),
      [`POST ${docPath}/doc_loopback/blocks/doc_loopback/descendant`]: () =>
        ok({ children: [block("body_loopback")] }),
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
    expect(
      requests.map(({ body, ...request }) =>
        Object.assign(request, body ? { body: JSON.parse(body) as unknown } : {}),
      ),
    ).toEqual([
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
      { method: "GET", path: "/open-apis/docx/v1/documents/doc_loopback/blocks", body: {} },
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
      const child = { ...block("after_loopback"), parent_id: "parent_loopback" };
      const { server } = serve({
        [`GET ${docPath}/doc_loopback/blocks/after_loopback`]: () => ok({ block: child }),
        [`GET ${docPath}/doc_loopback/blocks/parent_loopback/children`]: (_, url) => {
          pageTokens.push(url.searchParams.get("page_token"));
          if (pageTokens.length > 2) {
            return { code: 1, msg: "unexpected third pagination request" };
          }
          return ok({
            items: [child],
            has_more: true,
            ...(pageToken ? { page_token: pageToken } : {}),
          });
        },
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
    const patchResponses = [
      { code: 230001, msg: "replace rejected" },
      { code: 0, data: { block: { block_id: "image_two", block_type: 27 } } },
    ];
    const images = [block("image_one", 27), block("image_two", 27)];
    const { server, requests } = serve({
      [`POST ${docPath}`]: ({ body }) => {
        const title = (JSON.parse(body ?? "{}") as { title?: string }).title;
        return ok({
          document: {
            document_id: title === "Permission OK" ? "doc_permission_ok" : "doc_permission_no",
            title,
          },
        });
      },
      "POST /open-apis/drive/v1/permissions/doc_permission_ok/members": () =>
        ok({ member: { member_id: "ou_requester" } }),
      "POST /open-apis/drive/v1/permissions/doc_permission_no/members": () => ({
        code: 999,
        msg: "grant denied",
      }),
      [`POST ${docPath}/blocks/convert`]: () =>
        ok({ blocks: images, first_level_block_ids: ["image_one", "image_two"] }),
      [`GET ${docPath}/doc_images/blocks`]: () => ok({ items: [] }),
      [`POST ${docPath}/doc_images/blocks/doc_images/descendant`]: () => ok({ children: images }),
      "POST /open-apis/drive/v1/medias/upload_all": () =>
        ok({ file_token: `file_${requests.length}` }),
      [`PATCH ${docPath}/doc_images/blocks/image_one`]: () => patchResponses.shift(),
      [`PATCH ${docPath}/doc_images/blocks/image_two`]: () => patchResponses.shift(),
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
    expect(
      requests
        .filter((request) => request.path.includes("/permissions/"))
        .map((request) => request.body),
    ).toEqual([
      '{"member_type":"openid","member_id":"ou_requester","perm":"edit"}',
      '{"member_type":"openid","member_id":"ou_requester","perm":"edit"}',
    ]);
  });
});
