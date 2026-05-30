import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const messageListMock = vi.hoisted(() => vi.fn());
const messageDeleteMock = vi.hoisted(() => vi.fn());
const messageReadUsersMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((account: { appId?: string } | undefined) => ({
    __appId: account?.appId,
    im: {
      message: {
        list: messageListMock,
        delete: messageDeleteMock,
        readUsers: messageReadUsersMock,
      },
    },
  })),
);

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let registerFeishuMessageTools: typeof import("./message-tool.js").registerFeishuMessageTools;
let FeishuMessageSchema: typeof import("./message-schema.js").FeishuMessageSchema;

function createConfig(params?: {
  toolsA?: { messages?: boolean };
  toolsB?: { messages?: boolean };
  enableMessagesByDefault?: boolean;
}): OpenClawPluginApi["config"] {
  const defaultTools = params?.enableMessagesByDefault === false ? undefined : { messages: true };
  return {
    channels: {
      feishu: {
        enabled: true,
        accounts: {
          a: {
            appId: "app-a",
            appSecret: "sec-a", // pragma: allowlist secret
            tools: params?.toolsA ?? defaultTools,
          },
          b: {
            appId: "app-b",
            appSecret: "sec-b", // pragma: allowlist secret
            tools: params?.toolsB ?? defaultTools,
          },
        },
      },
    },
  } as OpenClawPluginApi["config"];
}

function lastClientAppId(): string | undefined {
  const calls = createFeishuClientMock.mock.calls;
  return calls[calls.length - 1]?.[0]?.appId;
}

describe("registerFeishuMessageTools", () => {
  beforeAll(async () => {
    ({ registerFeishuMessageTools } = await import("./message-tool.js"));
    ({ FeishuMessageSchema } = await import("./message-schema.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    messageListMock.mockResolvedValue({
      code: 0,
      data: { has_more: false, page_token: undefined, items: [] },
    });
    messageDeleteMock.mockResolvedValue({ code: 0 });
    messageReadUsersMock.mockResolvedValue({
      code: 0,
      data: { has_more: false, page_token: undefined, items: [] },
    });
  });

  it("exposes a flat provider-compatible parameter schema", () => {
    const serialized = JSON.stringify(FeishuMessageSchema);

    expect(serialized).not.toContain('"anyOf"');
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).not.toContain('"allOf"');
    expect(FeishuMessageSchema).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "delete", "recall", "read_receipts", "read_users"],
        },
      },
    });
  });

  it("lists chat messages with Unix-second time filters", async () => {
    messageListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: true,
        page_token: "next-token",
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            msg_type: "text",
            body: { content: '{"text":"hello"}' },
            sender: { id: "ou_1", id_type: "open_id", sender_type: "user" },
            create_time: "1710000000",
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "b" });
    const result = await tool.execute("call", {
      action: "list",
      chat_id: "oc_1",
      start_time: " 1710000000 ",
      end_time: "1710000060",
      page_size: 5,
      page_token: "cursor",
      sort_type: "ByCreateTimeAsc",
    });

    expect(lastClientAppId()).toBe("app-b");
    expect(messageListMock).toHaveBeenCalledWith({
      params: {
        container_id_type: "chat",
        container_id: "oc_1",
        start_time: "1710000000",
        end_time: "1710000060",
        page_size: 5,
        page_token: "cursor",
        sort_type: "ByCreateTimeAsc",
      },
    });
    expect(result.details).toEqual({
      chat_id: "oc_1",
      has_more: true,
      page_token: "next-token",
      messages: [
        {
          message_id: "om_1",
          parent_id: undefined,
          root_id: undefined,
          thread_id: undefined,
          chat_id: "oc_1",
          chat_type: undefined,
          message_type: "text",
          content: "hello",
          raw_content: '{"text":"hello"}',
          sender_id: "ou_1",
          sender_id_type: "open_id",
          sender_type: "user",
          create_time: "1710000000",
          update_time: undefined,
          deleted: undefined,
          updated: undefined,
        },
      ],
    });
  });

  it("rejects ISO 8601 time filters before sending them to Feishu", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "list",
      chat_id: "oc_1",
      start_time: "2026-05-18T00:00:00Z",
    });

    expect(messageListMock).not.toHaveBeenCalled();
    expect(result.details.error).toContain("start_time must be a Unix timestamp in seconds");
  });

  it("validates action-specific required fields at runtime", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const missingChat = await tool.execute("call", { action: "list" });
    const missingDeleteMessage = await tool.execute("call", { action: "delete" });
    const missingReadMessage = await tool.execute("call", { action: "read_receipts" });

    expect(messageListMock).not.toHaveBeenCalled();
    expect(messageDeleteMock).not.toHaveBeenCalled();
    expect(messageReadUsersMock).not.toHaveBeenCalled();
    expect(missingChat.details.error).toBe("feishu_message list requires chat_id");
    expect(missingDeleteMessage.details.error).toBe("feishu_message delete requires message_id");
    expect(missingReadMessage.details.error).toBe(
      "feishu_message read_receipts requires message_id",
    );
  });

  it("returns delete-specific success details", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "delete",
      message_id: "om_1",
      chat_id: "oc_1",
    });

    expect(messageDeleteMock).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
    });
    expect(result.details).toEqual({
      success: true,
      action: "delete",
      deleted: true,
      message_id: "om_1",
      chat_id: "oc_1",
    });
  });

  it("returns recall-specific success details", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "recall",
      message_id: "om_1",
      chat_id: "oc_1",
    });

    expect(result.details).toEqual({
      success: true,
      action: "recall",
      recalled: true,
      message_id: "om_1",
      chat_id: "oc_1",
    });
  });

  it("queries message read receipts with user ID and pagination controls", async () => {
    messageReadUsersMock.mockResolvedValueOnce({
      code: 0,
      data: {
        has_more: true,
        page_token: "next-users",
        items: [
          {
            user_id_type: "user_id",
            user_id: "u_1",
            timestamp: "1710000123",
            tenant_key: "tenant_1",
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "read_receipts",
      message_id: "om_1",
      user_id_type: "user_id",
      page_size: 10,
      page_token: "cursor",
    });

    expect(messageReadUsersMock).toHaveBeenCalledWith({
      params: {
        user_id_type: "user_id",
        page_size: 10,
        page_token: "cursor",
      },
      path: { message_id: "om_1" },
    });
    expect(result.details).toEqual({
      message_id: "om_1",
      user_id_type: "user_id",
      has_more: true,
      page_token: "next-users",
      users: [
        {
          user_id_type: "user_id",
          user_id: "u_1",
          timestamp: "1710000123",
          tenant_key: "tenant_1",
        },
      ],
    });
  });

  it("accepts read_users as a read receipt action alias", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "read_users",
      message_id: "om_1",
    });

    expect(messageReadUsersMock).toHaveBeenCalledWith({
      params: {
        user_id_type: "open_id",
        page_size: 20,
        page_token: undefined,
      },
      path: { message_id: "om_1" },
    });
    expect(result.details).toMatchObject({
      message_id: "om_1",
      user_id_type: "open_id",
      users: [],
    });
  });

  it("keeps delete timeout errors distinct from recall errors", async () => {
    messageDeleteMock.mockResolvedValueOnce({ code: 99991662, msg: "too old" });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "delete",
      message_id: "om_1",
      chat_id: "oc_1",
    });

    expect(result.details.error).toContain("Feishu message delete failed");
    expect(result.details.error).not.toContain("recall");
  });

  it("surfaces the missing group-message scope on delete", async () => {
    messageDeleteMock.mockResolvedValueOnce({
      code: 230027,
      msg: "Lack of necessary permissions, ext=need scope: im:message.group_msg",
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "delete",
      message_id: "om_1",
      chat_id: "oc_1",
    });

    expect(result.details.error).toContain("missing Feishu scope im:message.group_msg");
  });

  it("keeps recall timeout errors distinct from delete errors", async () => {
    messageDeleteMock.mockResolvedValueOnce({ code: 99991662, msg: "too old" });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "recall",
      message_id: "om_1",
      chat_id: "oc_1",
    });

    expect(result.details.error).toContain("Feishu message recall failed");
    expect(result.details.error).not.toContain("delete");
  });

  it("keeps read receipt errors distinct from delete and recall errors", async () => {
    messageReadUsersMock.mockResolvedValueOnce({ code: 230099, msg: "no permission" });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "read_receipts",
      message_id: "om_1",
    });

    expect(result.details.error).toContain("Feishu message read_receipts failed");
    expect(result.details.error).not.toContain("delete");
    expect(result.details.error).not.toContain("recall");
  });

  it("allows explicit accountId to override the contextual account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "b" });
    await tool.execute("call", {
      action: "delete",
      message_id: "om_1",
      accountId: "a",
    });

    expect(lastClientAppId()).toBe("app-a");
  });

  it("rejects execution when the resolved account disables message tools", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ toolsA: { messages: false }, toolsB: { messages: true } }),
    );
    registerFeishuMessageTools(api);

    const tool = resolveTool("feishu_message", { agentAccountId: "b" });
    const result = await tool.execute("call", {
      action: "delete",
      message_id: "om_1",
      accountId: "a",
    });

    expect(messageDeleteMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu message tools are disabled for account "a".');
  });

  it("skips registration by default", () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ enableMessagesByDefault: false }),
    );
    registerFeishuMessageTools(api);

    expect(() => resolveTool("feishu_message")).toThrow();
  });

  it("skips registration when all accounts disable messages", () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ toolsA: { messages: false }, toolsB: { messages: false } }),
    );
    registerFeishuMessageTools(api);

    expect(() => resolveTool("feishu_message")).toThrow();
  });
});
