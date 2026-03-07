import { describe, it, expect, beforeEach, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerFeishuReactionTools } from "./reaction.js";
import * as reactions from "./reactions.js";

describe("feishu_reaction tool", () => {
  let mockApi: Partial<OpenClawPluginApi>;
  let registeredTool: any;

  beforeEach(() => {
    registeredTool = null;
    mockApi = {
      config: {
        channels: {
          feishu: {
            appId: "test_app_id",
            appSecret: "test_app_secret",
            encryptKey: "test_encrypt_key",
            verificationToken: "test_token",
          },
        },
      } as any,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      registerTool: vi.fn((tool) => {
        registeredTool = tool;
      }),
    };
  });

  it("registers feishu_reaction tool when reaction is enabled", () => {
    registerFeishuReactionTools(mockApi as OpenClawPluginApi);
    expect(mockApi.registerTool).toHaveBeenCalled();
    expect(registeredTool?.name).toBe("feishu_reaction");
  });

  it("execute add action calls addReactionFeishu", async () => {
    vi.spyOn(reactions, "addReactionFeishu").mockResolvedValue({ reactionId: "react_123" });

    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "add",
      message_id: "msg_123",
      emoji_type: "THUMBSUP",
    });

    expect(reactions.addReactionFeishu).toHaveBeenCalledWith({
      cfg: mockApi.config,
      messageId: "msg_123",
      emojiType: "THUMBSUP",
      accountId: undefined,
    });
    expect(result.content[0].text).toContain("reaction_123");
  });

  it("add action returns error when emoji_type is missing", async () => {
    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "add",
      message_id: "msg_123",
    });

    expect(result.content[0].text).toContain("emoji_type is required");
  });

  it("execute remove action calls removeReactionFeishu", async () => {
    vi.spyOn(reactions, "removeReactionFeishu").mockResolvedValue();

    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "remove",
      message_id: "msg_123",
      reaction_id: "react_123",
    });

    expect(reactions.removeReactionFeishu).toHaveBeenCalledWith({
      cfg: mockApi.config,
      messageId: "msg_123",
      reactionId: "react_123",
      accountId: undefined,
    });
    expect(result.content[0].text).toContain("success");
  });

  it("remove action returns error when reaction_id is missing", async () => {
    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "remove",
      message_id: "msg_123",
    });

    expect(result.content[0].text).toContain("reaction_id is required");
  });

  it("execute list action calls listReactionsFeishu", async () => {
    vi.spyOn(reactions, "listReactionsFeishu").mockResolvedValue([
      { reactionId: "r1", emojiType: "THUMBSUP", operatorType: "user", operatorId: "u1" },
    ]);

    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "list",
      message_id: "msg_123",
    });

    expect(reactions.listReactionsFeishu).toHaveBeenCalledWith({
      cfg: mockApi.config,
      messageId: "msg_123",
      emojiType: undefined,
      accountId: undefined,
    });
    expect(result.content[0].text).toContain("THUMBSUP");
  });

  it("returns error for unknown action", async () => {
    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "unknown" as any,
      message_id: "msg_123",
    });

    expect(result.content[0].text).toContain("Unknown action");
  });

  it("handles errors gracefully", async () => {
    vi.spyOn(reactions, "addReactionFeishu").mockRejectedValue(new Error("API failed"));

    registerFeishuReactionTools(mockApi as OpenClawPluginApi);

    const result = await registeredTool.execute("call_1", {
      action: "add",
      message_id: "msg_123",
      emoji_type: "THUMBSUP",
    });

    expect(result.content[0].text).toContain("API failed");
  });
});
