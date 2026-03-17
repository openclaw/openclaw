import { describe, expect, it, vi } from "vitest";
import { sendMessageTwitchInternal } from "./send.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig
} from "./test-fixtures.js";
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  getAccountConfig: vi.fn()
}));
vi.mock("./utils/twitch.js", () => ({
  generateMessageId: vi.fn(() => "test-msg-id"),
  isAccountConfigured: vi.fn(() => true),
  normalizeTwitchChannel: (channel) => channel.toLowerCase().replace(/^#/, "")
}));
vi.mock("./utils/markdown.js", () => ({
  stripMarkdownForTwitch: vi.fn((text) => text.replace(/\*\*/g, ""))
}));
vi.mock("./client-manager-registry.js", () => ({
  getClientManager: vi.fn()
}));
describe("send", () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };
  const mockAccount = {
    ...BASE_TWITCH_TEST_ACCOUNT,
    accessToken: "test123"
  };
  const mockConfig = makeTwitchTestConfig(mockAccount);
  installTwitchTestHooks();
  describe("sendMessageTwitchInternal", () => {
    async function mockSuccessfulSend(params) {
      const { getAccountConfig } = await import("./config.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      const { stripMarkdownForTwitch } = await import("./utils/markdown.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockResolvedValue({
          ok: true,
          messageId: params.messageId
        })
      });
      vi.mocked(stripMarkdownForTwitch).mockImplementation(
        params.stripMarkdown ?? ((text) => text)
      );
      return { stripMarkdownForTwitch };
    }
    it("should send a message successfully", async () => {
      await mockSuccessfulSend({ messageId: "twitch-msg-123" });
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello Twitch!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("twitch-msg-123");
    });
    it("should strip markdown when enabled", async () => {
      const { stripMarkdownForTwitch } = await mockSuccessfulSend({
        messageId: "twitch-msg-456",
        stripMarkdown: (text) => text.replace(/\*\*/g, "")
      });
      await sendMessageTwitchInternal(
        "#testchannel",
        "**Bold** text",
        mockConfig,
        "default",
        true,
        mockLogger
      );
      expect(stripMarkdownForTwitch).toHaveBeenCalledWith("**Bold** text");
    });
    it("should return error when account not found", async () => {
      const { getAccountConfig } = await import("./config.js");
      vi.mocked(getAccountConfig).mockReturnValue(null);
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "nonexistent",
        false,
        mockLogger
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Account not found: nonexistent");
    });
    it("should return error when account not configured", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(false);
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("not properly configured");
    });
    it("should return error when no channel specified", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const accountWithoutChannel = {
        ...mockAccount,
        channel: void 0
      };
      vi.mocked(getAccountConfig).mockReturnValue(accountWithoutChannel);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      const result = await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("No channel specified");
    });
    it("should skip sending empty message after markdown stripping", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { stripMarkdownForTwitch } = await import("./utils/markdown.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(stripMarkdownForTwitch).mockReturnValue("");
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "**Only markdown**",
        mockConfig,
        "default",
        true,
        mockLogger
      );
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe("skipped");
    });
    it("should return error when client manager not found", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(getClientManager).mockReturnValue(void 0);
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Client manager not found");
    });
    it("should handle send errors gracefully", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: vi.fn().mockRejectedValue(new Error("Connection lost"))
      });
      const result = await sendMessageTwitchInternal(
        "#testchannel",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Connection lost");
      expect(mockLogger.error).toHaveBeenCalled();
    });
    it("should use account channel when channel parameter is empty", async () => {
      const { getAccountConfig } = await import("./config.js");
      const { isAccountConfigured } = await import("./utils/twitch.js");
      const { getClientManager } = await import("./client-manager-registry.js");
      vi.mocked(getAccountConfig).mockReturnValue(mockAccount);
      vi.mocked(isAccountConfigured).mockReturnValue(true);
      const mockSend = vi.fn().mockResolvedValue({
        ok: true,
        messageId: "twitch-msg-789"
      });
      vi.mocked(getClientManager).mockReturnValue({
        sendMessage: mockSend
      });
      await sendMessageTwitchInternal(
        "",
        "Hello!",
        mockConfig,
        "default",
        false,
        mockLogger
      );
      expect(mockSend).toHaveBeenCalledWith(
        mockAccount,
        "testchannel",
        // normalized account channel
        "Hello!",
        mockConfig,
        "default"
      );
    });
  });
});
