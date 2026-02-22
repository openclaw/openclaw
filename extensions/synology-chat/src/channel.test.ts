import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external dependencies
vi.mock("openclaw/plugin-sdk", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn((_opts: any) => ({})),
  registerPluginHttpRoute: vi.fn(() => vi.fn()),
  buildChannelConfigSchema: vi.fn((schema: any) => ({ schema })),
}));

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
  sendToChannel: vi.fn().mockResolvedValue(true),
}));

vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: vi.fn(() => vi.fn()),
}));

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue({
          counts: {},
        }),
      },
    },
  })),
}));

vi.mock("zod", () => ({
  z: {
    object: vi.fn(() => ({
      passthrough: vi.fn(() => ({ _type: "zod-schema" })),
    })),
  },
}));

const { createSynologyChatPlugin } = await import("./channel.js");

/** Helper: base account with all required fields for tests */
function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    incomingUrl: "https://nas/incoming",
    nasHost: "h",
    webhookPath: "/w",
    dmPolicy: "allowlist" as const,
    allowedUserIds: ["user1"],
    groupPolicy: "disabled" as const,
    groupAllowFrom: [] as string[],
    channelWebhooks: {} as Record<string, string>,
    channelTokens: {} as Record<string, string>,
    rateLimitPerMinute: 30,
    botName: "Bot",
    allowInsecureSsl: false,
    ...overrides,
  };
}

describe("createSynologyChatPlugin", () => {
  it("returns a plugin object with all required sections", () => {
    const plugin = createSynologyChatPlugin();
    expect(plugin.id).toBe("synology-chat");
    expect(plugin.meta).toBeDefined();
    expect(plugin.capabilities).toBeDefined();
    expect(plugin.config).toBeDefined();
    expect(plugin.security).toBeDefined();
    expect(plugin.outbound).toBeDefined();
    expect(plugin.gateway).toBeDefined();
  });

  describe("meta", () => {
    it("has correct id and label", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.meta.id).toBe("synology-chat");
      expect(plugin.meta.label).toBe("Synology Chat");
    });
  });

  describe("capabilities", () => {
    it("supports direct and group chat with media", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.capabilities.chatTypes).toEqual(["direct", "group"]);
      expect(plugin.capabilities.media).toBe(true);
      expect(plugin.capabilities.threads).toBe(false);
    });
  });

  describe("config", () => {
    it("listAccountIds delegates to accounts module", () => {
      const plugin = createSynologyChatPlugin();
      const result = plugin.config.listAccountIds({});
      expect(Array.isArray(result)).toBe(true);
    });

    it("resolveAccount returns account config", () => {
      const cfg = { channels: { "synology-chat": { token: "t1" } } };
      const plugin = createSynologyChatPlugin();
      const account = plugin.config.resolveAccount(cfg, "default");
      expect(account.accountId).toBe("default");
    });

    it("defaultAccountId returns 'default'", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.config.defaultAccountId({})).toBe("default");
    });
  });

  describe("security", () => {
    it("resolveDmPolicy returns policy, allowFrom, normalizeEntry", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ allowInsecureSsl: true });
      const result = plugin.security.resolveDmPolicy({ cfg: {}, account });
      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual(["user1"]);
      expect(typeof result.normalizeEntry).toBe("function");
      expect(result.normalizeEntry("  USER1  ")).toBe("user1");
    });
  });

  describe("pairing", () => {
    it("has notifyApproval and normalizeAllowEntry", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.pairing.idLabel).toBe("synologyChatUserId");
      expect(typeof plugin.pairing.normalizeAllowEntry).toBe("function");
      expect(plugin.pairing.normalizeAllowEntry("  USER1  ")).toBe("user1");
      expect(typeof plugin.pairing.notifyApproval).toBe("function");
    });
  });

  describe("security.collectWarnings", () => {
    it("warns when token is missing", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ token: "" });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("token"))).toBe(true);
    });

    it("warns when allowInsecureSsl is true", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ allowInsecureSsl: true });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("SSL"))).toBe(true);
    });

    it("warns when dmPolicy is open", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ dmPolicy: "open" });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("open"))).toBe(true);
    });

    it("warns when groupPolicy enabled but no channelTokens", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ groupPolicy: "open", channelTokens: {} });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("channelTokens"))).toBe(true);
    });

    it("warns when groupPolicy enabled but no channelWebhooks", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({ groupPolicy: "open", channelWebhooks: {} });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("channelWebhooks"))).toBe(true);
    });

    it("warns when groupPolicy is open", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount({
        groupPolicy: "open",
        channelWebhooks: { "9": "https://nas/channel" },
      });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("groupPolicy"))).toBe(true);
    });

    it("returns no warnings for fully configured account", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeAccount();
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings).toHaveLength(0);
    });
  });

  describe("messaging", () => {
    it("normalizeTarget strips prefix and trims", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.messaging.normalizeTarget("synology-chat:123")).toBe("123");
      expect(plugin.messaging.normalizeTarget("  456  ")).toBe("456");
      expect(plugin.messaging.normalizeTarget("")).toBeUndefined();
    });

    it("targetResolver.looksLikeId matches numeric IDs", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.messaging.targetResolver.looksLikeId("12345")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("synology-chat:99")).toBe(true);
      expect(plugin.messaging.targetResolver.looksLikeId("notanumber")).toBe(false);
      expect(plugin.messaging.targetResolver.looksLikeId("")).toBe(false);
    });
  });

  describe("directory", () => {
    it("returns empty stubs", async () => {
      const plugin = createSynologyChatPlugin();
      expect(await plugin.directory.self()).toBeNull();
      expect(await plugin.directory.listPeers()).toEqual([]);
      expect(await plugin.directory.listGroups()).toEqual([]);
    });
  });

  describe("agentPrompt", () => {
    it("returns formatting hints", () => {
      const plugin = createSynologyChatPlugin();
      const hints = plugin.agentPrompt.messageToolHints();
      expect(Array.isArray(hints)).toBe(true);
      expect(hints.length).toBeGreaterThan(5);
      expect(hints.some((h: string) => h.includes("<URL|display text>"))).toBe(true);
    });
  });

  describe("outbound", () => {
    it("sendText throws when no incomingUrl", async () => {
      const plugin = createSynologyChatPlugin();
      await expect(
        plugin.outbound.sendText({
          account: makeAccount({ incomingUrl: "", allowInsecureSsl: true }),
          text: "hello",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });

    it("sendText returns OutboundDeliveryResult on success", async () => {
      const plugin = createSynologyChatPlugin();
      const result = await plugin.outbound.sendText({
        account: makeAccount({ dmPolicy: "open", allowInsecureSsl: true }),
        text: "hello",
        to: "user1",
      });
      expect(result.channel).toBe("synology-chat");
      expect(result.messageId).toBeDefined();
      expect(result.chatId).toBe("user1");
    });

    it("sendText routes to channel when 'to' is group-encoded", async () => {
      const plugin = createSynologyChatPlugin();
      const result = await plugin.outbound.sendText({
        account: makeAccount({
          allowInsecureSsl: true,
          channelWebhooks: { "9": "https://nas/channel-webhook" },
        }),
        text: "hello channel",
        to: "group:9:456",
      });
      expect(result.channel).toBe("synology-chat");
      expect(result.chatId).toBe("456");
    });

    it("sendText falls back to DM when group channel has no webhook", async () => {
      const plugin = createSynologyChatPlugin();
      const result = await plugin.outbound.sendText({
        account: makeAccount({ allowInsecureSsl: true }),
        text: "hello fallback",
        to: "group:99:456",
      });
      expect(result.channel).toBe("synology-chat");
      expect(result.chatId).toBe("456");
    });

    it("sendMedia throws when missing incomingUrl", async () => {
      const plugin = createSynologyChatPlugin();
      await expect(
        plugin.outbound.sendMedia({
          account: makeAccount({ incomingUrl: "", allowInsecureSsl: true }),
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });
  });

  describe("gateway", () => {
    it("startAccount returns stop function for disabled account", async () => {
      const plugin = createSynologyChatPlugin();
      const ctx = {
        cfg: {
          channels: { "synology-chat": { enabled: false } },
        },
        accountId: "default",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
      const result = (await plugin.gateway.startAccount(ctx)) as { stop: () => void };
      expect(typeof result.stop).toBe("function");
    });

    it("startAccount returns stop function for account without token", async () => {
      const plugin = createSynologyChatPlugin();
      const ctx = {
        cfg: {
          channels: { "synology-chat": { enabled: true } },
        },
        accountId: "default",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      };
      const result = (await plugin.gateway.startAccount(ctx)) as { stop: () => void };
      expect(typeof result.stop).toBe("function");
    });
  });
});
