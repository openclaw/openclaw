import { describe, expect, it, vi } from "vitest";

vi.mock("./agent/api-client.js", () => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  uploadMedia: vi.fn(),
}));

describe("wecomOutbound", () => {
  it("does not crash when called with core outbound params", async () => {
    const { wecomOutbound } = await import("./outbound.js");
    await expect(
      wecomOutbound.sendMedia({
        cfg: {},
        to: "wr-test-chat",
        text: "caption",
        mediaUrl: "https://example.com/media.png",
      } as any),
    ).rejects.toThrow(/Agent mode/i);
  });

  it("routes sendText to agent chatId/userid", async () => {
    const { wecomOutbound } = await import("./outbound.js");
    const api = await import("./agent/api-client.js");
    const now = vi.spyOn(Date, "now").mockReturnValue(123);
    (api.sendText as any).mockResolvedValue(undefined);

    const cfg = {
      channels: {
        wecom: {
          enabled: true,
          agent: {
            corpId: "corp",
            corpSecret: "secret",
            agentId: 1000002,
            token: "token",
            encodingAESKey: "aes",
          },
        },
      },
    };

    // Chat ID (wr/wc) is intentionally NOT supported for Agent outbound.
    await expect(wecomOutbound.sendText({ cfg, to: "wr123", text: "hello" } as any)).rejects.toThrow(
      /不支持向群 chatId 发送/,
    );
    expect(api.sendText).not.toHaveBeenCalled();

    // Test: User ID (Default)
    const userResult = await wecomOutbound.sendText({
      cfg,
      to: "userid123",
      text: "hi",
    } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: undefined,
        toUser: "userid123",
        toParty: undefined,
        toTag: undefined,
        text: "hi",
      }),
    );
    expect(userResult.messageId).toBe("agent-123");

    (api.sendText as any).mockClear();

    // Test: User ID explicit
    await wecomOutbound.sendText({ cfg, to: "user:zhangsan", text: "hi" } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: "zhangsan", toParty: undefined }),
    );

    (api.sendText as any).mockClear();

    // Test: Party ID (Numeric)
    await wecomOutbound.sendText({ cfg, to: "1001", text: "hi party" } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: undefined, toParty: "1001" }),
    );

    (api.sendText as any).mockClear();

    // Test: Party ID Explicit
    await wecomOutbound.sendText({ cfg, to: "party:2002", text: "hi party 2" } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: undefined, toParty: "2002" }),
    );

    (api.sendText as any).mockClear();

    // Test: Tag ID Explicit
    await wecomOutbound.sendText({ cfg, to: "tag:1", text: "hi tag" } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ toUser: undefined, toTag: "1" }),
    );

    now.mockRestore();
  });

  it("suppresses /new ack for bot sessions but not agent sessions", async () => {
    const { wecomOutbound } = await import("./outbound.js");
    const api = await import("./agent/api-client.js");
    const now = vi.spyOn(Date, "now").mockReturnValue(456);
    (api.sendText as any).mockResolvedValue(undefined);
    (api.sendText as any).mockClear();

    const cfg = {
      channels: {
        wecom: {
          enabled: true,
          agent: {
            corpId: "corp",
            corpSecret: "secret",
            agentId: 1000002,
            token: "token",
            encodingAESKey: "aes",
          },
        },
      },
    };

    const ack = "✅ New session started · model: openai-codex/gpt-5.2";

    // Bot 会话（wecom:...）应抑制，避免私信回执
    const r1 = await wecomOutbound.sendText({ cfg, to: "wecom:userid123", text: ack } as any);
    expect(api.sendText).not.toHaveBeenCalled();
    expect(r1.messageId).toBe("suppressed-456");

    (api.sendText as any).mockClear();

    // Agent 会话（wecom-agent:...）允许发送回执
    await wecomOutbound.sendText({ cfg, to: "wecom-agent:userid123", text: ack } as any);
    expect(api.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        toUser: "userid123",
        text: "✅ 已开启新会话（模型：openai-codex/gpt-5.2）",
      }),
    );

    now.mockRestore();
  });
});
