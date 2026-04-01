import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import { createPluginRuntimeMock } from "../../../test/helpers/plugins/plugin-runtime-mock.js";
import type { OpenClawPluginApi } from "../runtime-api.js";

const createFeishuToolClientMock = vi.hoisted(() => vi.fn());
const resolveAnyEnabledFeishuToolsConfigMock = vi.hoisted(() => vi.fn());

vi.mock("./tool-account.js", () => ({
  createFeishuToolClient: createFeishuToolClientMock,
  resolveAnyEnabledFeishuToolsConfig: resolveAnyEnabledFeishuToolsConfigMock,
}));

let registerFeishuDriveTools: typeof import("./drive.js").registerFeishuDriveTools;

function createDriveToolApi(params: {
  config: OpenClawPluginApi["config"];
  registerTool: OpenClawPluginApi["registerTool"];
}): OpenClawPluginApi {
  return createTestPluginApi({
    id: "feishu-test",
    name: "Feishu Test",
    source: "local",
    config: params.config,
    runtime: createPluginRuntimeMock(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerTool: params.registerTool,
  });
}

describe("registerFeishuDriveTools", () => {
  const requestMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ registerFeishuDriveTools } = await import("./drive.js"));
    resolveAnyEnabledFeishuToolsConfigMock.mockReturnValue({
      doc: false,
      chat: false,
      wiki: false,
      drive: true,
      perm: false,
      scopes: false,
    });
    createFeishuToolClientMock.mockReturnValue({
      request: requestMock,
    });
  });

  it("registers feishu_drive and handles comment actions", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    expect(tool?.name).toBe("feishu_drive");

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "0",
        items: [
          {
            comment_id: "c1",
            quote: "quoted text",
            reply_list: {
              replies: [
                {
                  reply_id: "r1",
                  user_id: "ou_author",
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "root comment" },
                      },
                    ],
                  },
                },
                {
                  reply_id: "r2",
                  user_id: "ou_reply",
                  content: {
                    elements: [
                      {
                        type: "text_run",
                        text_run: { text: "reply text" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const listResult = await tool.execute("call-1", {
      action: "list_comments",
      file_token: "doc_1",
      file_type: "docx",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(listResult.details).toEqual(
      expect.objectContaining({
        comments: [
          expect.objectContaining({
            comment_id: "c1",
            text: "root comment",
            quote: "quoted text",
            replies: [expect.objectContaining({ reply_id: "r2", text: "reply text" })],
          }),
        ],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "0",
        items: [
          {
            reply_id: "r3",
            user_id: "ou_reply_2",
            content: {
              elements: [
                {
                  type: "text_run",
                  text_run: { content: "reply from api" },
                },
              ],
            },
          },
        ],
      },
    });
    const repliesResult = await tool.execute("call-2", {
      action: "list_comment_replies",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "GET",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx&user_id_type=open_id",
      }),
    );
    expect(repliesResult.details).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ reply_id: "r3", text: "reply from api" })],
      }),
    );

    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { comment_id: "c2" },
    });
    const addCommentResult = await tool.execute("call-3", {
      action: "add_comment",
      file_token: "doc_1",
      file_type: "docx",
      block_id: "blk_1",
      content: "please update this section",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/new_comments",
        data: {
          file_type: "docx",
          reply_elements: [{ type: "text", text: "please update this section" }],
          anchor: { block_id: "blk_1" },
        },
      }),
    );
    expect(addCommentResult.details).toEqual(
      expect.objectContaining({ success: true, comment_id: "c2" }),
    );

    requestMock
      .mockResolvedValueOnce({
        code: 99991663,
        msg: "invalid request body",
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { reply_id: "r4" },
      });
    const replyCommentResult = await tool.execute("call-4", {
      action: "reply_comment",
      file_token: "doc_1",
      file_type: "docx",
      comment_id: "c1",
      content: "handled",
    });
    expect(requestMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx",
        data: {
          content: {
            elements: [
              {
                type: "text_run",
                text_run: {
                  text: "handled",
                },
              },
            ],
          },
        },
      }),
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        method: "POST",
        url: "/open-apis/drive/v1/files/doc_1/comments/c1/replies?file_type=docx",
        data: {
          reply_elements: [{ type: "text", text: "handled" }],
        },
      }),
    );
    expect(replyCommentResult.details).toEqual(
      expect.objectContaining({ success: true, reply_id: "r4" }),
    );
  });

  it("rejects block-scoped comments for non-docx files", async () => {
    const registerTool = vi.fn();
    registerFeishuDriveTools(
      createDriveToolApi({
        config: {
          channels: {
            feishu: {
              enabled: true,
              appId: "app_id",
              appSecret: "app_secret", // pragma: allowlist secret
              tools: { drive: true },
            },
          },
        },
        registerTool,
      }),
    );

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tool = toolFactory?.({ agentAccountId: undefined });
    const result = await tool.execute("call-5", {
      action: "add_comment",
      file_token: "doc_1",
      file_type: "doc",
      block_id: "blk_1",
      content: "invalid",
    });
    expect(result.details).toEqual(
      expect.objectContaining({
        error: "block_id is only supported for docx comments",
      }),
    );
  });
});
