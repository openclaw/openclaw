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

describe("feishu_doc image fetch hardening", () => {
  const createDocMock = vi.hoisted(() => vi.fn());
  const convertMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
  const driveUploadAllMock = vi.hoisted(() => vi.fn());
  const importTaskCreateMock = vi.hoisted(() => vi.fn());
  const importTaskGetMock = vi.hoisted(() => vi.fn());
  const driveFileDeleteMock = vi.hoisted(() => vi.fn());
  const blockPatchMock = vi.hoisted(() => vi.fn());
  const scopeListMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          create: createDocMock,
          convert: convertMock,
        },
        documentBlock: {
          list: blockListMock,
          patch: blockPatchMock,
        },
        documentBlockChildren: {
          create: blockChildrenCreateMock,
        },
      },
      drive: {
        file: {
          delete: driveFileDeleteMock,
        },
        importTask: {
          create: importTaskCreateMock,
          get: importTaskGetMock,
        },
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
        blocks: [{ block_type: 27 }],
        first_level_block_ids: [],
      },
    });

    blockListMock.mockResolvedValue({
      code: 0,
      data: {
        items: [],
      },
    });

    blockChildrenCreateMock.mockResolvedValue({
      code: 0,
      data: {
        children: [{ block_type: 27, block_id: "img_block_1" }],
      },
    });

    createDocMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "tmp_doc_1", title: "tmp" } },
    });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    importTaskCreateMock.mockResolvedValue({ code: 0, data: { ticket: "ticket_1" } });
    importTaskGetMock.mockResolvedValue({
      code: 0,
      data: {
        result: {
          job_status: 0,
          token: "imported_doc_1",
          url: "https://feishu.cn/docx/imported_doc_1",
        },
      },
    });
    driveFileDeleteMock.mockResolvedValue({ code: 0, data: { task_id: "cleanup_task_1" } });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  it("skips image upload when markdown image URL is blocked", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchRemoteMediaMock.mockRejectedValueOnce(
      new Error("Blocked: resolves to private/internal IP address"),
    );

    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: {
        channels: {
          feishu: {
            appId: "app_id",
            appSecret: "app_secret",
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "feishu_doc");
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

  it("uses import path when write mode=import", async () => {
    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: {
        channels: {
          feishu: {
            appId: "app_id",
            appSecret: "app_secret",
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "write",
      mode: "import",
      doc_token: "old_doc_1",
      title: "Imported by write mode",
      folder_token: "folder_1",
      content: "# Hello",
    });

    expect(importTaskCreateMock).toHaveBeenCalledTimes(1);
    expect(importTaskGetMock).toHaveBeenCalledTimes(1);
    expect(driveFileDeleteMock).toHaveBeenCalledTimes(1);
    expect(result.details.method).toBe("import_task");
    expect(result.details.old_doc_token).toBe("old_doc_1");
  });

  it("returns validation error when write mode=import misses required fields", async () => {
    const registerTool = vi.fn();
    registerFeishuDocTools({
      config: {
        channels: {
          feishu: {
            appId: "app_id",
            appSecret: "app_secret",
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "write",
      mode: "import",
      doc_token: "old_doc_1",
      content: "# Hello",
    });

    expect(String(result.details.error)).toContain(
      "write mode=import requires both title and folder_token",
    );
  });
});
