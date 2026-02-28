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
  const documentCreateMock = vi.hoisted(() => vi.fn());
  const blockListMock = vi.hoisted(() => vi.fn());
  const blockChildrenCreateMock = vi.hoisted(() => vi.fn());
  const blockChildrenGetMock = vi.hoisted(() => vi.fn());
  const blockChildrenBatchDeleteMock = vi.hoisted(() => vi.fn());
  const blockDescendantCreateMock = vi.hoisted(() => vi.fn());
  const driveUploadAllMock = vi.hoisted(() => vi.fn());
  const permissionMemberCreateMock = vi.hoisted(() => vi.fn());
  const blockPatchMock = vi.hoisted(() => vi.fn());
  const scopeListMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();

    createFeishuClientMock.mockReturnValue({
      docx: {
        document: {
          convert: convertMock,
          create: documentCreateMock,
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
    // write/append use Descendant API; return image block so processImages runs
    blockDescendantCreateMock.mockResolvedValue({
      code: 0,
      data: { children: [{ block_type: 27, block_id: "img_block_1" }] },
    });
    driveUploadAllMock.mockResolvedValue({ file_token: "token_1" });
    documentCreateMock.mockResolvedValue({
      code: 0,
      data: { document: { document_id: "doc_created", title: "Created Doc" } },
    });
    permissionMemberCreateMock.mockResolvedValue({ code: 0 });
    blockPatchMock.mockResolvedValue({ code: 0 });
    scopeListMock.mockResolvedValue({ code: 0, data: { scopes: [] } });
  });

  it("inserts blocks sequentially to preserve document order", async () => {
    const blocks = [
      { block_type: 3, block_id: "h1" },
      { block_type: 2, block_id: "t1" },
      { block_type: 3, block_id: "h2" },
    ];
    convertMock.mockResolvedValue({
      code: 0,
      data: {
        blocks,
        first_level_block_ids: ["h1", "t1", "h2"],
      },
    });

    blockListMock.mockResolvedValue({ code: 0, data: { items: [] } });

    blockDescendantCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { children: [{ block_type: 3, block_id: "h1" }] },
    });

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

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      content: "plain text body",
    });

    expect(blockDescendantCreateMock).toHaveBeenCalledTimes(1);
    const call = blockDescendantCreateMock.mock.calls[0]?.[0];
    expect(call?.data.children_id).toEqual(["h1", "t1", "h2"]);
    expect(call?.data.descendants).toBeDefined();
    expect(call?.data.descendants.length).toBeGreaterThanOrEqual(3);

    expect(result.details.blocks_added).toBe(3);
  });

  it("falls back to size-based convert chunking for long no-heading markdown", async () => {
    let successChunkCount = 0;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      if (content.length > 280) {
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `b_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_type: 2, block_id: blockId }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockDescendantCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: {
        children: (data.children_id as string[]).map((id) => ({
          block_id: id,
        })),
      },
    }));

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

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const longMarkdown = Array.from(
      { length: 120 },
      (_, i) => `line ${i} with enough content to trigger fallback chunking`,
    ).join("\n");

    const result = await feishuDocTool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      content: longMarkdown,
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    expect(result.details.blocks_added).toBe(successChunkCount);
  });

  it("keeps fenced code blocks balanced when size fallback split is needed", async () => {
    const convertedChunks: string[] = [];
    let successChunkCount = 0;
    let failFirstConvert = true;
    convertMock.mockImplementation(async ({ data }) => {
      const content = data.content as string;
      convertedChunks.push(content);
      if (failFirstConvert) {
        failFirstConvert = false;
        return { code: 999, msg: "content too large" };
      }
      successChunkCount++;
      const blockId = `c_${successChunkCount}`;
      return {
        code: 0,
        data: {
          blocks: [{ block_type: 2, block_id: blockId }],
          first_level_block_ids: [blockId],
        },
      };
    });

    blockChildrenCreateMock.mockImplementation(async ({ data }) => ({
      code: 0,
      data: { children: data.children },
    }));

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

    const feishuDocTool = registerTool.mock.calls
      .map((call) => call[0])
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const fencedMarkdown = [
      "## Section",
      "```ts",
      "const alpha = 1;",
      "const beta = 2;",
      "const gamma = alpha + beta;",
      "console.log(gamma);",
      "```",
      "",
      "Tail paragraph one with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph two with enough text to exceed API limits when combined. ".repeat(8),
      "Tail paragraph three with enough text to exceed API limits when combined. ".repeat(8),
    ].join("\n");

    const result = await feishuDocTool.execute("tool-call", {
      action: "append",
      doc_token: "doc_1",
      content: fencedMarkdown,
    });

    expect(convertMock.mock.calls.length).toBeGreaterThan(1);
    expect(successChunkCount).toBeGreaterThan(1);
    for (const chunk of convertedChunks) {
      const fenceCount = chunk.match(/```/g)?.length ?? 0;
      expect(fenceCount % 2).toBe(0);
    }
    expect(result.details.blocks_added).toBe(successChunkCount);
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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
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

  it("reports owner permission details when grant succeeds", async () => {
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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "create",
      title: "Demo",
      owner_open_id: "ou_123",
      owner_perm_type: "edit",
    });

    expect(permissionMemberCreateMock).toHaveBeenCalled();
    expect(result.details.owner_permission_added).toBe(true);
    expect(result.details.owner_open_id).toBe("ou_123");
    expect(result.details.owner_perm_type).toBe("edit");
  });

  it("does not report owner permission details when grant fails", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    permissionMemberCreateMock.mockRejectedValueOnce(new Error("permission denied"));

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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "create",
      title: "Demo",
      owner_open_id: "ou_123",
      owner_perm_type: "edit",
    });

    expect(permissionMemberCreateMock).toHaveBeenCalled();
    expect(result.details.owner_permission_added).toBeUndefined();
    expect(result.details.owner_open_id).toBeUndefined();
    expect(result.details.owner_perm_type).toBeUndefined();
    expect(consoleWarnSpy).toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("skips permission grant when owner_open_id is omitted", async () => {
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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "create",
      title: "Demo",
    });

    expect(permissionMemberCreateMock).not.toHaveBeenCalled();
    expect(result.details.owner_permission_added).toBeUndefined();
  });

  it("returns an error when create response omits document_id", async () => {
    documentCreateMock.mockResolvedValueOnce({
      code: 0,
      data: { document: { title: "Created Doc" } },
    });

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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
      .find((tool) => tool.name === "feishu_doc");
    expect(feishuDocTool).toBeDefined();

    const result = await feishuDocTool.execute("tool-call", {
      action: "create",
      title: "Demo",
    });

    expect(result.details.error).toContain("no document_id");
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
      .map((tool) => (typeof tool === "function" ? tool({}) : tool))
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

  it("returns an error when upload_file cannot list placeholder siblings", async () => {
    blockChildrenCreateMock.mockResolvedValueOnce({
      code: 0,
      data: {
        children: [{ block_type: 23, block_id: "file_block_1" }],
      },
    });
    blockChildrenGetMock.mockResolvedValueOnce({
      code: 999,
      msg: "list failed",
      data: { items: [] },
    });

    const localPath = join(tmpdir(), `feishu-docx-upload-fail-${Date.now()}.txt`);
    await fs.writeFile(localPath, "hello from local file", "utf8");

    try {
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
        .map((tool) => (typeof tool === "function" ? tool({}) : tool))
        .find((tool) => tool.name === "feishu_doc");
      expect(feishuDocTool).toBeDefined();

      const result = await feishuDocTool.execute("tool-call", {
        action: "upload_file",
        doc_token: "doc_1",
        file_path: localPath,
        filename: "test-local.txt",
      });

      expect(result.details.error).toBe("list failed");
      expect(driveUploadAllMock).not.toHaveBeenCalled();
    } finally {
      await fs.unlink(localPath);
    }
  });
});
