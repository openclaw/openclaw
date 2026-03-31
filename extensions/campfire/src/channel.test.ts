import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCampfirePlugin } from "./channel.js";

describe("campfire channel plugin", () => {
  it("sends outbound text using account chunk settings", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({
      sendText,
      now: () => 123,
    });

    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          textChunkLimit: 2500,
        },
      },
    } as OpenClawConfig;

    const result = await plugin.outbound?.sendText?.({
      cfg,
      to: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      text: "Hello world",
      accountId: "default",
    });

    expect(sendText).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      "Hello world",
      "42-AbCdEf",
      2500,
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "campfire",
        chatId: "campfire:room:7",
        messageId: "campfire-123",
      }),
    );
  });

  it("rejects outbound targets outside the configured base URL", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({ sendText });
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
        },
      },
    } as OpenClawConfig;

    await expect(
      plugin.outbound?.sendText?.({
        cfg,
        to: "https://attacker.example.net/rooms/7/key/messages",
        text: "Hello world",
        accountId: "default",
      }),
    ).rejects.toThrow("must match channels.campfire.baseUrl");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects outbound targets outside the configured workspace path", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({ sendText });
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://3.basecamp.com/1234567",
          botKey: "42-AbCdEf",
        },
      },
    } as OpenClawConfig;

    await expect(
      plugin.outbound?.sendText?.({
        cfg,
        to: "https://3.basecamp.com/7654321/buckets/7/chats/88/messages/99",
        text: "Hello world",
        accountId: "default",
      }),
    ).rejects.toThrow("must match channels.campfire.baseUrl");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resolves outbound session routing to stable room identity", async () => {
    const plugin = createCampfirePlugin();

    const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
    });

    expect(route).toEqual(
      expect.objectContaining({
        peer: { kind: "group", id: "7" },
        chatType: "group",
        from: "campfire:room:7",
        to: "campfire:room:7",
      }),
    );
    expect(route?.sessionKey).toContain(":group:7");
    expect(route?.sessionKey).not.toContain("https://campfire.example.com");
  });

  it("uses Basecamp bucket id for outbound session routing", async () => {
    const plugin = createCampfirePlugin();

    const route = await plugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "https://3.basecamp.com/1234567/buckets/7/chats/88/messages/99",
    });

    expect(route).toEqual(
      expect.objectContaining({
        peer: { kind: "group", id: "7" },
        from: "campfire:room:7",
        to: "campfire:room:7",
      }),
    );
    expect(route?.sessionKey).toContain(":group:7");
  });

  it("exposes setup applyAccountConfig for channel add", () => {
    const plugin = createCampfirePlugin();

    const next = plugin.setup?.applyAccountConfig({
      cfg: {},
      accountId: "default",
      input: {
        httpUrl: "https://3.basecamp.com/1234567/",
        botToken: "42-AbCdEf",
        webhookSecret: "shared-secret",
      },
    } as never);

    const section = next?.channels?.campfire as
      | {
          enabled?: boolean;
          baseUrl?: string;
          botKey?: string;
          webhookSecret?: string;
        }
      | undefined;
    expect(section).toBeTruthy();
    expect(section?.enabled).toBe(true);
    expect(section?.baseUrl).toBe("https://3.basecamp.com/1234567");
    expect(section?.botKey).toBe("42-AbCdEf");
    expect(section?.webhookSecret).toBe("shared-secret");
  });

  it("writes named-account setup values under channels.campfire.accounts", () => {
    const plugin = createCampfirePlugin();

    const next = plugin.setup?.applyAccountConfig({
      cfg: {},
      accountId: "support",
      input: {
        url: "https://3.basecamp.com/7654321",
        token: "99-ZyXwVu",
        webhookPath: "/channels/campfire/webhook/support",
        webhookSecret: "support-secret",
      },
    } as never);

    const section = next?.channels?.campfire as
      | {
          enabled?: boolean;
          accounts?: Record<
            string,
            {
              enabled?: boolean;
              baseUrl?: string;
              botKey?: string;
              webhookPath?: string;
              webhookSecret?: string;
            }
          >;
        }
      | undefined;
    expect(section?.enabled).toBe(true);
    expect(section?.accounts?.support?.enabled).toBe(true);
    expect(section?.accounts?.support?.baseUrl).toBe("https://3.basecamp.com/7654321");
    expect(section?.accounts?.support?.botKey).toBe("99-ZyXwVu");
    expect(section?.accounts?.support?.webhookPath).toBe("/channels/campfire/webhook/support");
    expect(section?.accounts?.support?.webhookSecret).toBe("support-secret");
  });

  it("preserves existing webhookSecret when setup input omits it", () => {
    const plugin = createCampfirePlugin();

    const next = plugin.setup?.applyAccountConfig({
      cfg: {
        channels: {
          campfire: {
            webhookSecret: "keep-me",
          },
        },
      },
      accountId: "default",
      input: {
        httpUrl: "https://3.basecamp.com/1234567",
        botToken: "42-AbCdEf",
      },
    } as never);

    const section = next?.channels?.campfire as
      | {
          webhookSecret?: string;
        }
      | undefined;
    expect(section?.webhookSecret).toBe("keep-me");
  });
});
