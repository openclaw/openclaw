import { describe, expect, it } from "vitest";
import { platformChannelPlugin } from "./channel.js";

describe("platform-channel integration", () => {
  it("should resolve account configuration", () => {
    const mockConfig = {
      channels: {
        "platform-channel": {},
      },
    };

    const accountIds = platformChannelPlugin.config.listAccountIds(mockConfig);
    expect(accountIds).toContain("default");

    const account = platformChannelPlugin.config.resolveAccount(mockConfig, "default");
    expect(account.accountId).toBe("default");
  });

  it("should have correct plugin metadata", () => {
    expect(platformChannelPlugin.id).toBe("platform-channel");
    expect(platformChannelPlugin.meta.name).toBe("Platform Channel");
    expect(platformChannelPlugin.capabilities.chatTypes).toContain("direct");
  });

  it("should configure outbound delivery mode", () => {
    expect(platformChannelPlugin.outbound?.deliveryMode).toBe("gateway");
    expect(platformChannelPlugin.outbound?.sendText).toBeDefined();
  });

  it("should handle missing webhook URL gracefully", async () => {
    const originalUrl = process.env.ELSE_PLATFORM_WEBHOOK_URL;
    delete process.env.ELSE_PLATFORM_WEBHOOK_URL;

    const result = await platformChannelPlugin.outbound?.sendText?.({
      cfg: {},
      to: "test-user",
      text: "test message",
    });

    expect(result?.ok).toBe(false);
    expect(result?.error?.message).toContain("ELSE_PLATFORM_WEBHOOK_URL not configured");

    // Restore
    if (originalUrl) {
      process.env.ELSE_PLATFORM_WEBHOOK_URL = originalUrl;
    }
  });

  it("should start account with gateway adapter", async () => {
    const mockContext = {
      cfg: {},
      accountId: "default",
      account: { accountId: "default" },
      runtime: {} as any,
      abortSignal: new AbortController().signal,
      log: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      getStatus: () => ({
        accountId: "default",
        configured: true,
        enabled: true,
        state: "running" as const,
      }),
      setStatus: () => {},
    };

    const result = await platformChannelPlugin.gateway?.startAccount?.(mockContext);
    expect(result).toBeDefined();
  });
});
