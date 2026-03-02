import { beforeEach, describe, expect, it, vi } from "vitest";

const createFeishuClientMock = vi.hoisted(() => vi.fn());
const fetchRemoteMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./runtime.js", () => ({
  getFeishuRuntime: () => ({
    channel: {
      media: {
        fetchRemoteMedia: fetchRemoteMediaMock,
      },
    },
  }),
}));

import { registerFeishuDocTools } from "./docx.js";

const convertMock = vi.hoisted(() => vi.fn());
const blockListMock = vi.hoisted(() => vi.fn());
const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
const driveUploadAllMock = vi.hoisted(() => vi.fn());
const blockPatchMock = vi.hoisted(() => vi.fn());
const scopeListMock = vi.hoisted(() => vi.fn());
const docCreateMock = vi.hoisted(() => vi.fn());
const docGetMock = vi.hoisted(() => vi.fn());
const docRawContentMock = vi.hoisted(() => vi.fn());

function setupMocks() {
  createFeishuClientMock.mockReturnValue({
    docx: {
      document: {
        convert: convertMock,
        create: docCreateMock,
        get: docGetMock,
        rawContent: docRawContentMock,
      },
      documentBlock: {
        list: blockListMock,
        patch: blockPatchMock,
        get: vi.fn().mockResolvedValue({ code: 0, data: { block: {} } }),
      },
      documentBlockChildren: {
        create: blockChildrenCreateMock,
        batchDelete: blockChildrenBatchDeleteMock,
        get: vi.fn().mockResolvedValue({ code: 0, data: { items: [] } }),
      },
    },
    drive: {
      media: {
        uploadAll: driveUploadAllMock,
      },
    },
    application: {
      scope: {
        list: scopeListMock,
      },
    },
  });

  convertMock.mockResolvedValue({
    code: 0,
    data: {
      blocks: [{ block_type: 2, block_id: "blk_1" }],
      first_level_block_ids: ["blk_1"],
    },
  });

  blockListMock.mockResolvedValue({
    code: 0,
    data: { items: [] },
  });

  blockChildrenCreateMock.mockResolvedValue({
    code: 0,
    data: { children: [{ block_type: 2, block_id: "blk_1" }] },
  });

  blockChildrenBatchDeleteMock.mockResolvedValue({ code: 0 });

  driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
  blockPatchMock.mockResolvedValue({ code: 0 });
  scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });

  docCreateMock.mockResolvedValue({
    code: 0,
    data: {
      document: {
        document_id: "new_doc_123",
        title: "Test Doc",
      },
    },
  });
}

function getFeishuDocTool() {
  const registerTool = vi.fn();
  registerFeishuDocTools({
    config: {
      channels: {
        feishu: { appId: "app_id", appSecret: "app_secret" },
      },
    } as any,
    logger: { debug: vi.fn(), info: vi.fn() } as any,
    registerTool,
  } as any);

  return registerTool.mock.calls
    .map((call) => call[0])
    .map((tool) => (typeof tool === "function" ? tool({}) : tool))
    .find((tool) => tool.name === "feishu_doc");
}

describe("feishu_doc create_with_content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it("creates a document and writes content in one step", async () => {
    const tool = getFeishuDocTool();
    expect(tool).toBeDefined();

    const result = await tool.execute("call-1", {
      action: "create_with_content",
      title: "Test Report",
      content: "# Hello\n\nWorld",
      folder_token: "fld_123",
    });

    expect(docCreateMock).toHaveBeenCalledWith({
      data: { title: "Test Report", folder_token: "fld_123" },
    });
    expect(convertMock).toHaveBeenCalled();
    expect(blockChildrenCreateMock).toHaveBeenCalled();
    expect(result.details.document_id).toBe("new_doc_123");
    expect(result.details.success).toBe(true);
  });

  it("returns error when title is missing", async () => {
    const tool = getFeishuDocTool();
    docCreateMock.mockRejectedValueOnce(new Error("title is required"));

    const result = await tool.execute("call-2", {
      action: "create_with_content",
      content: "# Hello",
    });

    expect(result.details.error).toContain("title is required");
  });
});

describe("feishu_doc image fetch hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();

    // Override for image-specific test
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks: [{ block_type: 27 }],
        first_level_block_ids: [],
      },
    });

    blockChildrenCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_type: 27, block_id: "img_block_1" }],
      },
    });
  });

  it("skips image upload when markdown image URL is blocked", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchRemoteMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    const feishuDocTool = getFeishuDocTool();
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "write",
      doc_token: "doc_1",
      content: "![x](https://x.test/image.png)",
    });

    expect(fetchRemoteMediaMock).toHaveBeenCalled();
    expect(driveUploadAllMock).not.toHaveBeenCalled();
    expect(blockPatchMock).not.toHaveBeenCalled();
    expect(result.details.images_processed).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
