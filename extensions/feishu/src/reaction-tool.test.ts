import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { createToolFactoryHarness } from "./tool-factory-test-harness.js";

const messageReactionCreateMock = vi.hoisted(() => vi.fn());
const messageReactionDeleteMock = vi.hoisted(() => vi.fn());
const messageReactionListMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() =>
  vi.fn((account: { appId?: string } | undefined) => ({
    __appId: account?.appId,
    im: {
      messageReaction: {
        create: messageReactionCreateMock,
        delete: messageReactionDeleteMock,
        list: messageReactionListMock,
      },
    },
  })),
);

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

let registerFeishuReactionTools: typeof import("./reaction-tool.js").registerFeishuReactionTools;

function createConfig(params?: {
  tools?: { reactions?: boolean } | null;
  toolsA?: { reactions?: boolean };
  toolsB?: { reactions?: boolean };
  actions?: { reactions?: boolean };
  actionsA?: { reactions?: boolean };
  actionsB?: { reactions?: boolean };
}): OpenClawPluginApi["config"] {
  return {
    channels: {
      feishu: {
        enabled: true,
        actions: params?.actions,
        tools: params?.tools === null ? undefined : (params?.tools ?? { reactions: true }),
        accounts: {
          a: {
            appId: "app-a",
            appSecret: "sec-a", // pragma: allowlist secret
            actions: params?.actionsA,
            tools:
              params?.tools === null ? params?.toolsA : (params?.toolsA ?? { reactions: true }),
          },
          b: {
            appId: "app-b",
            appSecret: "sec-b", // pragma: allowlist secret
            actions: params?.actionsB,
            tools:
              params?.tools === null ? params?.toolsB : (params?.toolsB ?? { reactions: true }),
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

describe("registerFeishuReactionTools", () => {
  beforeAll(async () => {
    ({ registerFeishuReactionTools } = await import("./reaction-tool.js"));
  });

  afterAll(() => {
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    messageReactionCreateMock.mockResolvedValue({ code: 0, data: { reaction_id: "r-new" } });
    messageReactionDeleteMock.mockResolvedValue({ code: 0 });
    messageReactionListMock.mockResolvedValue({ code: 0, data: { items: [] } });
  });

  it("adds a reaction using the contextual account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "b" });
    const result = await tool.execute("call", {
      action: "add",
      message_id: "om_1",
      emoji_type: "THUMBSUP",
    });

    expect(lastClientAppId()).toBe("app-b");
    expect(messageReactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { reaction_type: { emoji_type: "THUMBSUP" } },
    });
    expect(result.details).toEqual({
      success: true,
      message_id: "om_1",
      emoji_type: "THUMBSUP",
      reaction_id: "r-new",
    });
  });

  it("normalizes common emoji aliases before adding reactions", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "add",
      message_id: "om_1",
      emoji_type: "heart",
    });

    expect(messageReactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { reaction_type: { emoji_type: "HEART" } },
    });
    expect(result.details.emoji_type).toBe("HEART");
  });

  it("preserves canonical mixed-case Feishu emoji types", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "add",
      message_id: "om_1",
      emoji_type: "Typing",
    });

    expect(messageReactionCreateMock).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      data: { reaction_type: { emoji_type: "Typing" } },
    });
    expect(result.details.emoji_type).toBe("Typing");
  });

  it("lists reactions with an optional emoji filter", async () => {
    messageReactionListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "r1",
            reaction_type: { emoji_type: "HEART" },
            operator: { operator_type: "app", operator_id: "app-a" },
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "list",
      message_id: "om_1",
      emoji_type: "HEART",
    });

    expect(messageReactionListMock).toHaveBeenCalledWith({
      path: { message_id: "om_1" },
      params: { reaction_type: "HEART" },
    });
    expect(result.details.reactions).toEqual([
      {
        reactionId: "r1",
        emojiType: "HEART",
        operatorType: "app",
        operatorId: "app-a",
      },
    ]);
  });

  it("removes a reaction by reaction_id", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "remove",
      message_id: "om_1",
      reaction_id: "r1",
    });

    expect(messageReactionDeleteMock).toHaveBeenCalledWith({
      path: { message_id: "om_1", reaction_id: "r1" },
    });
    expect(result.details).toEqual({
      success: true,
      message_id: "om_1",
      removed: { reaction_id: "r1" },
    });
  });

  it("removes the bot's own reaction by emoji_type", async () => {
    messageReactionListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "user-r",
            reaction_type: { emoji_type: "OK" },
            operator: { operator_type: "user", operator_id: "ou_user" },
          },
          {
            reaction_id: "bot-r",
            reaction_type: { emoji_type: "OK" },
            operator: { operator_type: "app", operator_id: "app-a" },
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "remove",
      message_id: "om_1",
      emoji_type: "OK",
    });

    expect(messageReactionDeleteMock).toHaveBeenCalledWith({
      path: { message_id: "om_1", reaction_id: "bot-r" },
    });
    expect(result.details.removed).toEqual({ reaction_id: "bot-r" });
  });

  it("does not remove another app's reaction by emoji_type", async () => {
    messageReactionListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "other-app-r",
            reaction_type: { emoji_type: "OK" },
            operator: { operator_type: "app", operator_id: "app-b" },
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "remove",
      message_id: "om_1",
      emoji_type: "OK",
    });

    expect(messageReactionDeleteMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      success: true,
      message_id: "om_1",
      emoji_type: "OK",
      removed: false,
    });
  });

  it("returns a soft success when emoji removal finds no app reaction", async () => {
    messageReactionListMock.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            reaction_id: "user-r",
            reaction_type: { emoji_type: "OK" },
            operator: { operator_type: "user", operator_id: "ou_user" },
          },
        ],
      },
    });
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "remove",
      message_id: "om_1",
      emoji_type: "OK",
    });

    expect(messageReactionDeleteMock).not.toHaveBeenCalled();
    expect(result.details).toEqual({
      success: true,
      message_id: "om_1",
      emoji_type: "OK",
      removed: false,
    });
  });

  it("requires reaction_id or emoji_type for remove", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "a" });
    const result = await tool.execute("call", {
      action: "remove",
      message_id: "om_1",
    });

    expect(result.details.error).toBe("reaction_id or emoji_type is required for action remove");
    expect(messageReactionDeleteMock).not.toHaveBeenCalled();
  });

  it("skips registration when all accounts disable reactions", () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ toolsA: { reactions: false }, toolsB: { reactions: false } }),
    );
    registerFeishuReactionTools(api);

    expect(() => resolveTool("feishu_reaction")).toThrow();
  });

  it("keeps the native reaction tool opt-in", () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig({ tools: null }));
    registerFeishuReactionTools(api);

    expect(() => resolveTool("feishu_reaction")).toThrow();
  });

  it("skips registration when the reaction action gate is disabled", () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ actions: { reactions: false } }),
    );
    registerFeishuReactionTools(api);

    expect(() => resolveTool("feishu_reaction")).toThrow();
  });

  it("rejects execution when the resolved account disables reaction actions", async () => {
    const { api, resolveTool } = createToolFactoryHarness(
      createConfig({ actionsA: { reactions: false }, actionsB: { reactions: true } }),
    );
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "b" });
    const result = await tool.execute("call", {
      action: "add",
      message_id: "om_1",
      emoji_type: "CLAP",
      accountId: "a",
    });

    expect(messageReactionCreateMock).not.toHaveBeenCalled();
    expect(result.details.error).toBe('Feishu reaction tools are disabled for account "a".');
  });

  it("allows explicit accountId to override the contextual account", async () => {
    const { api, resolveTool } = createToolFactoryHarness(createConfig());
    registerFeishuReactionTools(api);

    const tool = resolveTool("feishu_reaction", { agentAccountId: "b" });
    await tool.execute("call", {
      action: "add",
      message_id: "om_1",
      emoji_type: "CLAP",
      accountId: "a",
    });

    expect(lastClientAppId()).toBe("app-a");
  });
});
