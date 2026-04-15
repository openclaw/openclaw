import { beforeEach, describe, expect, it, vi } from "vitest";
import { createToolFactoryHarness, type ToolLike } from "./tool-factory-test-harness.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const resolveFeishuToolAccountMock = vi.hoisted(() => vi.fn());
const requestMock = vi.hoisted(() => vi.fn());
const rawContentMock = vi.hoisted(() => vi.fn());
const documentGetMock = vi.hoisted(() => vi.fn());
const blockListMock = vi.hoisted(() => vi.fn());
const convertMock = vi.hoisted(() => vi.fn());
const documentCreateMock = vi.hoisted(() => vi.fn());
const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
const blockChildrenGetMock = vi.hoisted(() => vi.fn());
const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
const blockDescendantCreateMock = vi.hoisted(() => vi.fn());
const driveUploadAllMock = vi.hoisted(() => vi.fn());
const permissionMemberCreateMock = vi.hoisted(() => vi.fn());
const blockPatchMock = vi.hoisted(() => vi.fn());
const scopeListMock = vi.hoisted(() => vi.fn());

const toolAccountModule = await import("./tool-account.js");
const runtimeModule = await import("./runtime.js");

vi.spyOn(toolAccountModule, "createFeishuToolClient").mockImplementation(() =>
  createFeishuClientMock(),
);
vi.spyOn(toolAccountModule, "resolveAnyEnabledFeishuToolsConfig").mockReturnValue({
  doc: true,
  chat: false,
  wiki: false,
  drive: false,
  perm: false,
  scopes: false,
});
vi.spyOn(toolAccountModule, "resolveFeishuToolAccount").mockImplementation((...args) =>
  resolveFeishuToolAccountMock(...args),
);
vi.spyOn(runtimeModule, "getFeishuRuntime").mockImplementation(
  () =>
    ({
      channel: {
        media: {
          fetchRemoteMedia: vi.fn(),
          saveMediaBuffer: vi.fn(),
        },
      },
      media: {
        loadWebMedia: vi.fn(),
        detectMime: vi.fn(async () => "application/octet-stream"),
        mediaKindFromMime: vi.fn(() => "image"),
        isVoiceCompatibleAudio: vi.fn(() => false),
        getImageMetadata: vi.fn(async () => null),
        resizeToJpeg: vi.fn(async () => Buffer.alloc(0)),
      },
    }) as unknown as ReturnType<typeof runtimeModule.getFeishuRuntime>,
);

const { registerFeishuDocTools } = await import("./docx.js");

type ToolResultWithDetails = {
  details: Record<string, unknown>;
};

function mockDocxClient() {
  return {
    docx: {
      document: {
        convert: convertMock,
        create: documentCreateMock,
        rawContent: rawContentMock,
        get: documentGetMock,
      },
      documentBlock: {
        list: blockListMock,
        patch: blockPatchMock,
      },
      documentBlockChildren: {
        create: blockChildrenCreateMock,
        get: blockChildrenGetMock,
        batchDelete: blockChildrenBatchDeleteMock,
      },
      documentBlockDescendant: {
        create: blockDescendantCreateMock,
      },
    },
    drive: {
      media: {
        uploadAll: driveUploadAllMock,
      },
      permissionMember: {
        create: permissionMemberCreateMock,
      },
    },
    application: {
      scope: {
        list: scopeListMock,
      },
    },
    // client.request() used by old-doc.ts
    request: requestMock,
  };
}

const OLD_DOC_CONTENT = JSON.stringify({
  title: { elements: [{ text_run: { content: "Test Old Doc" } }] },
  body: {
    blocks: [
      { type: "paragraph", paragraph: { elements: [{ text_run: { content: "Hello world" } }] } },
      { type: "table", table: { row_size: 2, column_size: 3 } },
      {
        type: "code",
        code: { language: "python", elements: [{ text_run: { content: "print(1)" } }] },
      },
    ],
  },
});

function setupRequestMock(responses: Record<string, unknown>) {
  requestMock.mockImplementation((opts: { url: string }) => {
    for (const [urlPattern, response] of Object.entries(responses)) {
      if (opts.url.includes(urlPattern)) {
        return Promise.resolve(response);
      }
    }
    return Promise.resolve({ code: -1, msg: "Not mocked" });
  });
}

describe("feishu_doc old version document read", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue(mockDocxClient());
    resolveFeishuToolAccountMock.mockReturnValue({
      config: { mediaMaxMb: 30 },
    });

    // Default docx mocks
    rawContentMock.mockResolvedValue({ code: 0, data: { content: "new doc text" } });
    documentGetMock.mockResolvedValue({
      code: 0,
      data: { document: { title: "New Doc", revision_id: "rev1" } },
    });
    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });
    convertMock.mockResolvedValue({
      code: 0,
      data: { blocks: [], first_level_block_ids: [] },
    });
    documentCreateMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "doc_created", title: "Created Doc" } },
    });
    blockChildrenCreateMock.mockResolvedValue({ code: 0, data: { children: [] } });
    blockChildrenGetMock.mockResolvedValue({ code: 0, data: { items: [] } });
    blockChildrenBatchDeleteMock.mockResolvedValue({ code: 0 });
    blockDescendantCreateMock.mockResolvedValue({ code: 0, data: { children: [] } });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    permissionMemberCreateMock.mockResolvedValue({ code: 0 });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  function resolveFeishuDocTool(context: Record<string, unknown> = {}) {
    const harness = createToolFactoryHarness({
      channels: {
        feishu: {
          enabled: true,
          appId: "app_id",
          appSecret: "app_secret",
        },
      },
    });
    registerFeishuDocTools(harness.api);
    const tool = harness.resolveTool("feishu_doc", context);
    expect(tool).toBeDefined();
    return tool;
  }

  async function executeRead(tool: ToolLike, docToken: string) {
    return (await tool.execute("tool-call", {
      action: "read",
      doc_token: docToken,
    })) as ToolResultWithDetails;
  }

  it("reads old version document when meta says is_upgraded=false", async () => {
    setupRequestMock({
      "/open-apis/doc/v2/meta/": {
        code: 0,
        data: { title: "Old Doc Title", is_upgraded: false },
      },
      "/open-apis/doc/v2/old_token/raw_content": {
        code: 0,
        data: { content: "plain text from old doc" },
      },
      "/open-apis/doc/v2/old_token/content": {
        code: 0,
        data: { content: OLD_DOC_CONTENT },
      },
    });

    const tool = resolveFeishuDocTool();
    const result = await executeRead(tool, "old_token");

    expect(result.details.document_version).toBe("old");
    expect(result.details.content).toBe("plain text from old doc");
    expect(result.details.title).toBe("Old Doc Title");
    expect(result.details.block_count).toBe(3);
    expect(result.details.block_types).toEqual({
      paragraph: 1,
      table: 1,
      code: 1,
    });
    expect(result.details.hint).toContain("table");
  });

  it("redirects to upgraded token when meta says is_upgraded=true", async () => {
    // First meta call returns upgraded=true with upgraded_token
    // Second meta call (for upgraded token) should fall through to docx API
    let metaCallCount = 0;
    requestMock.mockImplementation((opts: { url: string }) => {
      if (opts.url.includes("/open-apis/doc/v2/meta/")) {
        metaCallCount++;
        if (metaCallCount === 1) {
          // Old doc token → upgraded
          return Promise.resolve({
            code: 0,
            data: { is_upgraded: true, upgraded_token: "new_docx_token" },
          });
        }
        // New docx token meta → not an old doc, throw to fall through
        return Promise.resolve({ code: 99999, msg: "not found" });
      }
      return Promise.resolve({ code: -1, msg: "Not mocked" });
    });

    const tool = resolveFeishuDocTool();
    const result = await executeRead(tool, "old_token");

    // Should have redirected to the new docx token and used docx API
    expect(result.details.title).toBe("New Doc");
    expect(result.details.content).toBe("new doc text");
    expect(rawContentMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: { document_id: "new_docx_token" } }),
    );
  });

  it("falls back to docx API when meta API fails", async () => {
    setupRequestMock({
      "/open-apis/doc/v2/meta/": {
        code: 91403,
        msg: "FORBIDDEN",
      },
    });

    const tool = resolveFeishuDocTool();
    const result = await executeRead(tool, "some_token");

    // Should fall through to docx API
    expect(result.details.title).toBe("New Doc");
    expect(result.details.content).toBe("new doc text");
    expect(result.details).not.toHaveProperty("document_version");
  });

  it("extracts title from content when meta has no title", async () => {
    setupRequestMock({
      "/open-apis/doc/v2/meta/": {
        code: 0,
        data: { is_upgraded: false }, // no title
      },
      "/open-apis/doc/v2/notitle/raw_content": {
        code: 0,
        data: { content: "content text" },
      },
      "/open-apis/doc/v2/notitle/content": {
        code: 0,
        data: { content: OLD_DOC_CONTENT }, // title is "Test Old Doc"
      },
    });

    const tool = resolveFeishuDocTool();
    const result = await executeRead(tool, "notitle");

    expect(result.details.title).toBe("Test Old Doc");
    expect(result.details.document_version).toBe("old");
  });

  it("handles empty old doc content gracefully", async () => {
    setupRequestMock({
      "/open-apis/doc/v2/meta/": {
        code: 0,
        data: { is_upgraded: false, title: "Empty Doc" },
      },
      "/open-apis/doc/v2/empty/raw_content": {
        code: 0,
        data: { content: "" },
      },
      "/open-apis/doc/v2/empty/content": {
        code: 0,
        data: { content: "" },
      },
    });

    const tool = resolveFeishuDocTool();
    const result = await executeRead(tool, "empty");

    expect(result.details.document_version).toBe("old");
    expect(result.details.content).toBe("");
    expect(result.details.block_count).toBe(0);
    expect(result.details.block_types).toEqual({});
    expect(result.details).not.toHaveProperty("hint");
  });
});
