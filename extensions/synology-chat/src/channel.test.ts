import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSecurityAccount, registerPluginHttpRouteMock } from "./channel.test-mocks.js";
import { sendMessage } from "./client.js";

vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: vi.fn(() => vi.fn()),
}));

const { createSynologyChatPlugin } = await import("./channel.js");
const mockSendMessage = vi.mocked(sendMessage);

describe("createSynologyChatPlugin", () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    registerPluginHttpRouteMock.mockClear();
  });

  describe("meta", () => {
    it("has correct id and label", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.meta.id).toBe("synology-chat");
      expect(plugin.meta.label).toBe("Synology Chat");
      expect(plugin.meta.docsPath).toBe("/channels/synology-chat");
    });
  });

  describe("capabilities", () => {
    it("supports direct chat with media", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.capabilities.chatTypes).toEqual(["direct"]);
      expect(plugin.capabilities.media).toBe(true);
      expect(plugin.capabilities.threads).toBe(false);
    });
  });

  describe("config", () => {
    it("listAccountIds includes default and named accounts when configured", () => {
      const plugin = createSynologyChatPlugin();
      const result = plugin.config.listAccountIds({
        channels: {
          "synology-chat": {
            token: "base-token",
            accounts: {
              office: { token: "office-token" },
            },
          },
        },
      });
      expect(result).toEqual(["default", "office"]);
    });

    it("resolveAccount merges account overrides with base config defaults", () => {
      const cfg = {
        channels: {
          "synology-chat": {
            token: "base-token",
            incomingUrl: "https://nas/base",
            nasHost: "nas-base",
            allowedUserIds: ["base-user"],
            rateLimitPerMinute: 45,
            botName: "Base Bot",
            accounts: {
              office: {
                token: "office-token",
                allowInsecureSsl: true,
              },
            },
          },
        },
      };
      const plugin = createSynologyChatPlugin();
      const account = plugin.config.resolveAccount(cfg, "office");
      expect(account).toMatchObject({
        accountId: "office",
        token: "office-token",
        incomingUrl: "https://nas/base",
        nasHost: "nas-base",
        allowedUserIds: ["base-user"],
        rateLimitPerMinute: 45,
        botName: "Base Bot",
        allowInsecureSsl: true,
      });
    });

    it("defaultAccountId returns 'default'", () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.config.defaultAccountId?.({})).toBe("default");
    });

    it("formats allowFrom entries through the shared adapter", () => {
      const plugin = createSynologyChatPlugin();
      expect(
        plugin.config.formatAllowFrom?.({
          cfg: {},
          allowFrom: ["  USER1  ", 42],
        }),
      ).toEqual(["user1", "42"]);
    });
  });

  describe("security", () => {
    it("resolveDmPolicy returns policy, allowFrom, normalizeEntry", () => {
      const plugin = createSynologyChatPlugin();
      const account = {
        accountId: "default",
        enabled: true,
        token: "t",
        incomingUrl: "u",
        nasHost: "h",
        webhookPath: "/w",
        dangerouslyAllowNameMatching: false,
        hasExplicitWebhookPath: true,
        dangerouslyAllowInheritedWebhookPath: false,
        dmPolicy: "allowlist" as const,
        allowedUserIds: ["user1"],
        rateLimitPerMinute: 30,
        botName: "Bot",
        allowInsecureSsl: true,
      };
      const result = plugin.security.resolveDmPolicy({ cfg: {}, account });
      if (!result) {
        throw new Error("resolveDmPolicy returned null");
      }
      expect(result.policy).toBe("allowlist");
      expect(result.allowFrom).toEqual(["user1"]);
      expect(result.normalizeEntry?.("  USER1  ")).toBe("user1");
    });
  });

  describe("pairing", () => {
    it("normalizes entries and notifies approved users", async () => {
      const plugin = createSynologyChatPlugin();
      expect(plugin.pairing.idLabel).toBe("synologyChatUserId");
      const normalize = plugin.pairing.normalizeAllowEntry;
      const notifyApproval = plugin.pairing.notifyApproval;
      if (!normalize || !notifyApproval) {
        throw new Error("synology-chat pairing helpers unavailable");
      }
      expect(normalize("  USER1  ")).toBe("user1");

      await notifyApproval({
        cfg: {
          channels: {
            "synology-chat": {
              token: "t",
              incomingUrl: "https://nas/incoming",
              allowInsecureSsl: true,
            },
          },
        },
        id: "USER1",
      });

      expect(mockSendMessage).toHaveBeenCalledWith(
        "https://nas/incoming",
        "OpenClaw: your access has been approved.",
        "USER1",
        true,
      );
    });
  });

  describe("security.collectWarnings", () => {
    it("warns when token is missing", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount({ token: "" });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("token"))).toBe(true);
    });

    it("warns when allowInsecureSsl is true", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount({ allowInsecureSsl: true });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("SSL"))).toBe(true);
    });

    it("warns when dangerous name matching is enabled", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount({ dangerouslyAllowNameMatching: true });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("dangerouslyAllowNameMatching"))).toBe(true);
    });

    it("warns when dmPolicy is open", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount({ dmPolicy: "open" });
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("open"))).toBe(true);
    });

    it("warns when dmPolicy is allowlist and allowedUserIds is empty", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount();
      const warnings = plugin.security.collectWarnings({ account });
      expect(warnings.some((w: string) => w.includes("empty allowedUserIds"))).toBe(true);
    });

    it("returns no warnings for fully configured account", () => {
      const plugin = createSynologyChatPlugin();
      const account = makeSecurityAccount({ allowedUserIds: ["user1"] });
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
      const params = { cfg: {}, runtime: {} as never };
      expect(await plugin.directory.self?.(params)).toBeNull();
      expect(await plugin.directory.listPeers?.(params)).toEqual([]);
      expect(await plugin.directory.listGroups?.(params)).toEqual([]);
    });
  });

  describe("agentPrompt", () => {
    it("returns formatting hints", () => {
      const plugin = createSynologyChatPlugin();
      const hints = plugin.agentPrompt.messageToolHints();
      expect(hints).toContain("### Synology Chat Formatting");
      expect(hints).toContain("**Links**: Use `<URL|display text>` to create clickable links.");
      expect(hints).toContain("- No buttons, cards, or interactive elements");
    });
  });

  describe("outbound", () => {
    it("sendText throws when no incomingUrl", async () => {
      const plugin = createSynologyChatPlugin();
      await expect(
        plugin.outbound.sendText({
          cfg: {
            channels: {
              "synology-chat": { enabled: true, token: "t", incomingUrl: "" },
            },
          },
          text: "hello",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });

    it("sendText returns OutboundDeliveryResult on success", async () => {
      const plugin = createSynologyChatPlugin();
      const result = await plugin.outbound.sendText({
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "t",
              incomingUrl: "https://nas/incoming",
              allowInsecureSsl: true,
            },
          },
        },
        text: "hello",
        to: "user1",
      });
      expect(result).toMatchObject({
        channel: "synology-chat",
        chatId: "user1",
      });
      expect(result.messageId).toMatch(/^sc-\d+$/);
    });

    it("sendMedia throws when missing incomingUrl", async () => {
      const plugin = createSynologyChatPlugin();
      await expect(
        plugin.outbound.sendMedia({
          cfg: {
            channels: {
              "synology-chat": { enabled: true, token: "t", incomingUrl: "" },
            },
          },
          mediaUrl: "https://example.com/img.png",
          to: "user1",
        }),
      ).rejects.toThrow("not configured");
    });
  });

  describe("gateway", () => {
    function makeStartAccountCtx(
      accountConfig: Record<string, unknown>,
      abortController = new AbortController(),
    ) {
      return {
        abortController,
        ctx: {
          cfg: {
            channels: { "synology-chat": accountConfig },
          },
          accountId: "default",
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          abortSignal: abortController.signal,
        },
      };
    }

    async function expectPendingStartAccountPromise(
      result: Promise<unknown>,
      abortController: AbortController,
    ) {
      expect(result).toBeInstanceOf(Promise);
      const resolved = await Promise.race([
        result,
        new Promise((r) => setTimeout(() => r("pending"), 50)),
      ]);
      expect(resolved).toBe("pending");
      abortController.abort();
      await result;
    }

    async function expectPendingStartAccount(accountConfig: Record<string, unknown>) {
      const plugin = createSynologyChatPlugin();
      const { ctx, abortController } = makeStartAccountCtx(accountConfig);
      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
    }

    it("startAccount returns pending promise for disabled account", async () => {
      await expectPendingStartAccount({ enabled: false });
    });

    it("startAccount returns pending promise for account without token", async () => {
      await expectPendingStartAccount({ enabled: true });
    });

    it("startAccount refuses allowlist accounts with empty allowedUserIds", async () => {
      const registerMock = registerPluginHttpRouteMock;
      registerMock.mockClear();
      const plugin = createSynologyChatPlugin();
      const { ctx, abortController } = makeStartAccountCtx({
        enabled: true,
        token: "t",
        incomingUrl: "https://nas/incoming",
        dmPolicy: "allowlist",
        allowedUserIds: [],
      });

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining("empty allowedUserIds"));
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses named accounts without explicit webhookPath in multi-account setups", async () => {
      const registerMock = registerPluginHttpRouteMock;
      const plugin = createSynologyChatPlugin();
      const abortController = new AbortController();
      const ctx = {
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "shared-token",
              incomingUrl: "https://nas/incoming",
              webhookPath: "/webhook/synology-shared",
              accounts: {
                alerts: {
                  enabled: true,
                  token: "alerts-token",
                  incomingUrl: "https://nas/alerts",
                  dmPolicy: "allowlist",
                  allowedUserIds: ["123"],
                },
              },
            },
          },
        },
        accountId: "alerts",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        abortSignal: abortController.signal,
      };

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("must set an explicit webhookPath"),
      );
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("startAccount refuses duplicate exact webhook paths across accounts", async () => {
      const registerMock = registerPluginHttpRouteMock;
      const plugin = createSynologyChatPlugin();
      const abortController = new AbortController();
      const ctx = {
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              accounts: {
                default: {
                  enabled: true,
                  token: "default-token",
                  incomingUrl: "https://nas/default",
                  webhookPath: "/webhook/synology-shared",
                  dmPolicy: "allowlist",
                  allowedUserIds: ["123"],
                },
                alerts: {
                  enabled: true,
                  token: "alerts-token",
                  incomingUrl: "https://nas/alerts",
                  webhookPath: "/webhook/synology-shared",
                  dmPolicy: "open",
                },
              },
            },
          },
        },
        accountId: "alerts",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        abortSignal: abortController.signal,
      };

      const result = plugin.gateway.startAccount(ctx);
      await expectPendingStartAccountPromise(result, abortController);
      expect(ctx.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("conflicts on webhookPath"),
      );
      expect(registerMock).not.toHaveBeenCalled();
    });

    it("deregisters stale route before re-registering same account/path", async () => {
      const unregisterFirst = vi.fn();
      const unregisterSecond = vi.fn();
      const registerMock = registerPluginHttpRouteMock;
      registerMock.mockReturnValueOnce(unregisterFirst).mockReturnValueOnce(unregisterSecond);

      const plugin = createSynologyChatPlugin();
      const abortFirst = new AbortController();
      const abortSecond = new AbortController();
      const makeCtx = (abortCtrl: AbortController) => ({
        cfg: {
          channels: {
            "synology-chat": {
              enabled: true,
              token: "t",
              incomingUrl: "https://nas/incoming",
              webhookPath: "/webhook/synology",
              dmPolicy: "allowlist",
              allowedUserIds: ["123"],
            },
          },
        },
        accountId: "default",
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        abortSignal: abortCtrl.signal,
      });

      // Start first account (returns a pending promise)
      const firstPromise = plugin.gateway.startAccount(makeCtx(abortFirst));
      // Start second account on same path — should deregister the first route
      const secondPromise = plugin.gateway.startAccount(makeCtx(abortSecond));

      // Give microtasks time to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(registerMock).toHaveBeenCalledTimes(2);
      expect(unregisterFirst).toHaveBeenCalledTimes(1);
      expect(unregisterSecond).not.toHaveBeenCalled();

      // Clean up: abort both to resolve promises and prevent test leak
      abortFirst.abort();
      abortSecond.abort();
      await Promise.allSettled([firstPromise, secondPromise]);
    });
  });
});
