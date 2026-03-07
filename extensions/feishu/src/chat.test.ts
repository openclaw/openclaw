import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerFeishuChatTools } from "./chat.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const BASE_CONFIG = {
  channels: {
    feishu: {
      enabled: true,
      appId: "app_id",
      appSecret: "app_secret",
      tools: { chat: true },
    },
  },
} as any;

describe("registerFeishuChatTools", () => {
  const chatGetMock = vi.hoisted(() => vi.fn());
  const chatMembersGetMock = vi.hoisted(() => vi.fn());
  const chatCreateMock = vi.hoisted(() => vi.fn());
  const chatDeleteMock = vi.hoisted(() => vi.fn());
  const chatMembersCreateMock = vi.hoisted(() => vi.fn());
  const messageCreateMock = vi.hoisted(() => vi.fn());
  const imChatAnnouncementGetMock = vi.hoisted(() => vi.fn());
  const imChatAnnouncementPatchMock = vi.hoisted(() => vi.fn());
  const docxChatAnnouncementGetMock = vi.hoisted(() => vi.fn());
  const docxChatAnnouncementBlockListMock = vi.hoisted(() => vi.fn());
  const docxChatAnnouncementBlockGetMock = vi.hoisted(() => vi.fn());
  const docxChatAnnouncementBlockChildrenCreateMock = vi.hoisted(() => vi.fn());
  const docxChatAnnouncementBlockBatchUpdateMock = vi.hoisted(() => vi.fn());

  beforeEach(() => {
    vi.clearAllMocks();
    createFeishuClientMock.mockReturnValue({
      im: {
        chat: { get: chatGetMock, create: chatCreateMock, delete: chatDeleteMock },
        chatMembers: { get: chatMembersGetMock, create: chatMembersCreateMock },
        chatAnnouncement: { get: imChatAnnouncementGetMock, patch: imChatAnnouncementPatchMock },
        message: { create: messageCreateMock },
      },
      docx: {
        chatAnnouncement: { get: docxChatAnnouncementGetMock },
        chatAnnouncementBlock: {
          list: docxChatAnnouncementBlockListMock,
          get: docxChatAnnouncementBlockGetMock,
          batchUpdate: docxChatAnnouncementBlockBatchUpdateMock,
        },
        chatAnnouncementBlockChildren: { create: docxChatAnnouncementBlockChildrenCreateMock },
      },
    });
  });

  function setup() {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: BASE_CONFIG,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).toHaveBeenCalledTimes(1);
    const tool = registerTool.mock.calls[0]?.[0];
    expect(tool?.name).toBe("feishu_chat");
    return tool;
  }

  it("registers feishu_chat and handles info/members actions", async () => {
    const tool = setup();

    chatGetMock.mockResolvedValueOnce({
      code: 0,
      data: { name: "group name", user_count: 3 },
    });
    const infoResult = await tool.execute("tc_1", { action: "info", chat_id: "oc_1" });
    expect(infoResult.details).toEqual(
      expect.objectContaining({ chat_id: "oc_1", name: "group name", user_count: 3 }),
    );

    chatMembersGetMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: false,
        page_token: "",
        items: [{ member_id: "ou_1", name: "member1", member_id_type: "open_id" }],
      },
    });
    const membersResult = await tool.execute("tc_2", { action: "members", chat_id: "oc_1" });
    expect(membersResult.details).toEqual(
      expect.objectContaining({
        chat_id: "oc_1",
        members: [expect.objectContaining({ member_id: "ou_1", name: "member1" })],
      }),
    );
  });

  it("skips registration when chat tool is disabled", () => {
    const registerTool = vi.fn();
    registerFeishuChatTools({
      config: {
        channels: {
          feishu: {
            enabled: true,
            appId: "app_id",
            appSecret: "app_secret",
            tools: { chat: false },
          },
        },
      } as any,
      logger: { debug: vi.fn(), info: vi.fn() } as any,
      registerTool,
    } as any);
    expect(registerTool).not.toHaveBeenCalled();
  });

  describe("announcement actions", () => {
    it("get_announcement returns docx announcement with blocks", async () => {
      const tool = setup();

      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "docx", revision_id: 5 },
      });
      docxChatAnnouncementBlockListMock.mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { block_type: 1, block_id: "blk_page" },
            { block_type: 2, block_id: "blk_text" },
          ],
        },
      });

      const result = await tool.execute("tc_3", { action: "get_announcement", chat_id: "oc_1" });
      expect(result.details).toMatchObject({
        announcement_type: "docx",
        block_count: 2,
        block_types: { Page: 1, Text: 1 },
      });
    });

    it("get_announcement returns doc announcement via legacy im API", async () => {
      const tool = setup();

      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "doc" },
      });
      imChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { content: "hello doc", revision: 3 },
      });

      const result = await tool.execute("tc_4", { action: "get_announcement", chat_id: "oc_1" });
      expect(result.details).toMatchObject({ announcement_type: "doc", content: "hello doc" });
    });

    it("list_announcement_blocks returns block list", async () => {
      const tool = setup();

      docxChatAnnouncementBlockListMock.mockResolvedValueOnce({
        code: 0,
        data: { items: [{ block_type: 2, block_id: "blk_1" }] },
      });

      const result = await tool.execute("tc_5", {
        action: "list_announcement_blocks",
        chat_id: "oc_1",
      });
      expect(result.details).toMatchObject({ blocks: [{ block_id: "blk_1" }] });
    });

    it("get_announcement_block returns single block", async () => {
      const tool = setup();

      docxChatAnnouncementBlockGetMock.mockResolvedValueOnce({
        code: 0,
        data: { block: { block_type: 2, block_id: "blk_1" } },
      });

      const result = await tool.execute("tc_6", {
        action: "get_announcement_block",
        chat_id: "oc_1",
        block_id: "blk_1",
      });
      expect(result.details).toMatchObject({ block: { block_id: "blk_1" } });
    });

    it("write_announcement appends text block for docx announcement", async () => {
      const tool = setup();

      // getAnnouncement call
      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "docx", revision_id: 1 },
      });
      docxChatAnnouncementBlockListMock.mockResolvedValueOnce({
        code: 0,
        data: { items: [{ block_type: 1, block_id: "blk_page" }] },
      });
      // createTextBlock call
      docxChatAnnouncementBlockChildrenCreateMock.mockResolvedValueOnce({
        code: 0,
        data: { block_id: "blk_new" },
      });

      const result = await tool.execute("tc_7", {
        action: "write_announcement",
        chat_id: "oc_1",
        content: "new content",
      });
      expect(result.details).toMatchObject({ success: true });
    });

    it("append_announcement appends text block for docx announcement", async () => {
      const tool = setup();

      // getAnnouncement call
      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "docx", revision_id: 1 },
      });
      docxChatAnnouncementBlockListMock.mockResolvedValueOnce({
        code: 0,
        data: { items: [{ block_type: 1, block_id: "blk_page" }] },
      });
      // createTextBlock call
      docxChatAnnouncementBlockChildrenCreateMock.mockResolvedValueOnce({
        code: 0,
        data: { block_id: "blk_appended" },
      });

      const result = await tool.execute("tc_7b", {
        action: "append_announcement",
        chat_id: "oc_1",
        content: "appended text",
      });
      expect(result.details).toMatchObject({ success: true });
    });

    it("append_announcement concatenates content for doc announcement", async () => {
      const tool = setup();

      // getAnnouncement → doc type
      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "doc" },
      });
      imChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { content: "existing", revision: 2 },
      });
      // writeDocAnnouncement: im.chatAnnouncement.get then patch
      imChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { content: "existing", revision: 2 },
      });
      imChatAnnouncementPatchMock.mockResolvedValueOnce({ code: 0, data: {} });

      const result = await tool.execute("tc_7c", {
        action: "append_announcement",
        chat_id: "oc_1",
        content: "new",
      });
      expect(result.details).toMatchObject({ success: true, announcement_type: "doc" });
      // verify concatenation: patch was called with existing + "\n" + new
      expect(imChatAnnouncementPatchMock).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ content: "existing\nnew" }) }),
      );
    });

    it("update_announcement_block patches a block", async () => {
      const tool = setup();

      docxChatAnnouncementGetMock.mockResolvedValueOnce({
        code: 0,
        data: { announcement_type: "docx", revision_id: 2 },
      });
      docxChatAnnouncementBlockBatchUpdateMock.mockResolvedValueOnce({
        code: 0,
        data: {},
      });

      const result = await tool.execute("tc_8", {
        action: "update_announcement_block",
        chat_id: "oc_1",
        block_id: "blk_1",
        content: "updated text",
      });
      expect(result.details).toMatchObject({ success: true });
    });
  });

  describe("chat management actions", () => {
    it("create_chat creates a group and returns chat_id", async () => {
      const tool = setup();

      chatCreateMock.mockResolvedValueOnce({
        code: 0,
        data: { chat_id: "oc_new", name: "test group" },
      });

      const result = await tool.execute("tc_9", {
        action: "create_chat",
        name: "test group",
        user_ids: ["ou_1", "ou_2"],
      });
      expect(result.details).toMatchObject({ success: true, chat_id: "oc_new" });
    });

    it("add_members adds users to a chat", async () => {
      const tool = setup();

      chatMembersCreateMock.mockResolvedValueOnce({ code: 0, data: {} });

      const result = await tool.execute("tc_10", {
        action: "add_members",
        chat_id: "oc_1",
        user_ids: ["ou_3"],
      });
      expect(result.details).toMatchObject({
        success: true,
        chat_id: "oc_1",
        added_user_ids: ["ou_3"],
      });
    });

    it("check_bot_in_chat returns in_chat: true when bot is in chat", async () => {
      const tool = setup();

      chatGetMock.mockResolvedValueOnce({ code: 0, data: { name: "group" } });

      const result = await tool.execute("tc_11", {
        action: "check_bot_in_chat",
        chat_id: "oc_1",
      });
      expect(result.details).toMatchObject({ in_chat: true, chat_id: "oc_1" });
    });

    it("check_bot_in_chat returns in_chat: false when API responds with code 90003", async () => {
      const tool = setup();

      // Production path: SDK resolves with code 90003 in response body
      chatGetMock.mockResolvedValueOnce({ code: 90003, msg: "Robot is not in the group" });

      const result = await tool.execute("tc_12", {
        action: "check_bot_in_chat",
        chat_id: "oc_1",
      });
      expect(result.details).toMatchObject({ in_chat: false, chat_id: "oc_1" });
    });

    it("delete_chat deletes a chat", async () => {
      const tool = setup();

      chatDeleteMock.mockResolvedValueOnce({ code: 0, data: {} });

      const result = await tool.execute("tc_13", {
        action: "delete_chat",
        chat_id: "oc_1",
      });
      expect(result.details).toMatchObject({ success: true, chat_id: "oc_1" });
    });

    it("create_session_chat creates chat and sends greeting", async () => {
      const tool = setup();

      chatCreateMock.mockResolvedValueOnce({
        code: 0,
        data: { chat_id: "oc_session" },
      });
      messageCreateMock.mockResolvedValueOnce({
        code: 0,
        data: { message_id: "msg_1" },
      });

      const result = await tool.execute("tc_14", {
        action: "create_session_chat",
        name: "session",
        user_ids: ["ou_1"],
        greeting: "Hi there!",
      });
      expect(result.details).toMatchObject({
        success: true,
        chat_id: "oc_session",
        message_result: expect.objectContaining({ message_id: "msg_1" }),
      });
    });
  });
});
