import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const convertMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
  const blockChildrenGetMock = vi.hoisted(() => vi.fn());
  const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
  const driveUploadAllMock = vi.hoisted(() => vi.fn());
  const blockPatchMock = vi.hoisted(() => vi.fn());
  const scopeListMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          convert: convertMock,
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

    blockChildrenGetMock.mockResolvedValue({
      code: 0,
      data: { items: [{ block_id: "placeholder_block_1" }] },
    });
    blockChildrenBatchDeleteMock.mockResolvedValue({ code: 0 });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
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

  it("uploads local file to doc via upload_file action", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });

    const localPath = join(tmpdir(), `feishu-docx-upload-${Date.now()}.txt`);
    await fs.writeFile(localPath, "hello from local file", "utf8");

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
      action: "upload_file",
      doc_token: "doc_1",
      file_path: localPath,
      filename: "test-local.txt",
    });

    expect(result.details.success).toBe(true);
    expect(result.details.file_token).toBe("token_1");
    expect(result.details.file_name).toBe("test-local.txt");

    expect(driveUploadAllMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parent_type: "docx_file",
          parent_node: "doc_1",
          file_name: "test-local.txt",
        }),
      }),
    );

    await fs.unlink(localPath);
  });
});
