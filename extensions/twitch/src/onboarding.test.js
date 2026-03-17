import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("openclaw/plugin-sdk/twitch", () => ({
  formatDocsLink: (url, fallback) => fallback || url,
  promptChannelAccessConfig: vi.fn(async () => null)
}));
const mockPromptText = vi.fn();
const mockPromptConfirm = vi.fn();
const mockPrompter = {
  text: mockPromptText,
  confirm: mockPromptConfirm
};
const mockAccount = {
  username: "testbot",
  accessToken: "oauth:test123",
  clientId: "test-client-id",
  channel: "#testchannel"
};
describe("onboarding helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
  });
  describe("promptToken", () => {
    it("should return existing token when user confirms to keep it", async () => {
      const { promptToken } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValue(true);
      const result = await promptToken(mockPrompter, mockAccount, void 0);
      expect(result).toBe("oauth:test123");
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Access token already configured. Keep it?",
        initialValue: true
      });
      expect(mockPromptText).not.toHaveBeenCalled();
    });
    it("should prompt for new token when user doesn't keep existing", async () => {
      const { promptToken } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValue(false);
      mockPromptText.mockResolvedValue("oauth:newtoken123");
      const result = await promptToken(mockPrompter, mockAccount, void 0);
      expect(result).toBe("oauth:newtoken123");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch OAuth token (oauth:...)",
        initialValue: "",
        validate: expect.any(Function)
      });
    });
    it("should use env token as initial value when provided", async () => {
      const { promptToken } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValue(false);
      mockPromptText.mockResolvedValue("oauth:fromenv");
      await promptToken(mockPrompter, null, "oauth:fromenv");
      expect(mockPromptText).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "oauth:fromenv"
        })
      );
    });
    it("should validate token format", async () => {
      const { promptToken } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValueOnce(false);
      let promptTextCallCount = 0;
      let capturedValidate;
      mockPromptText.mockImplementationOnce((_args) => {
        promptTextCallCount++;
        if (_args?.validate) {
          capturedValidate = _args.validate;
        }
        return Promise.resolve("oauth:test123");
      });
      const result = await promptToken(mockPrompter, mockAccount, void 0);
      expect(promptTextCallCount).toBe(1);
      expect(result).toBe("oauth:test123");
      expect(capturedValidate).toBeDefined();
      expect(capturedValidate("")).toBe("Required");
      expect(capturedValidate("notoauth")).toBe("Token should start with 'oauth:'");
    });
    it("should return early when no existing token and no env token", async () => {
      const { promptToken } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("oauth:newtoken");
      const result = await promptToken(mockPrompter, null, void 0);
      expect(result).toBe("oauth:newtoken");
      expect(mockPromptConfirm).not.toHaveBeenCalled();
    });
  });
  describe("promptUsername", () => {
    it("should prompt for username with validation", async () => {
      const { promptUsername } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("mybot");
      const result = await promptUsername(mockPrompter, null);
      expect(result).toBe("mybot");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch bot username",
        initialValue: "",
        validate: expect.any(Function)
      });
    });
    it("should use existing username as initial value", async () => {
      const { promptUsername } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("testbot");
      await promptUsername(mockPrompter, mockAccount);
      expect(mockPromptText).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: "testbot"
        })
      );
    });
  });
  describe("promptClientId", () => {
    it("should prompt for client ID with validation", async () => {
      const { promptClientId } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("abc123xyz");
      const result = await promptClientId(mockPrompter, null);
      expect(result).toBe("abc123xyz");
      expect(mockPromptText).toHaveBeenCalledWith({
        message: "Twitch Client ID",
        initialValue: "",
        validate: expect.any(Function)
      });
    });
  });
  describe("promptChannelName", () => {
    it("should return channel name when provided", async () => {
      const { promptChannelName } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("#mychannel");
      const result = await promptChannelName(mockPrompter, null);
      expect(result).toBe("#mychannel");
    });
    it("should require a non-empty channel name", async () => {
      const { promptChannelName } = await import("./onboarding.js");
      mockPromptText.mockResolvedValue("");
      await promptChannelName(mockPrompter, null);
      const { validate } = mockPromptText.mock.calls[0]?.[0] ?? {};
      expect(validate?.("")).toBe("Required");
      expect(validate?.("   ")).toBe("Required");
      expect(validate?.("#chan")).toBeUndefined();
    });
  });
  describe("promptRefreshTokenSetup", () => {
    it("should return empty object when user declines", async () => {
      const { promptRefreshTokenSetup } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValue(false);
      const result = await promptRefreshTokenSetup(mockPrompter, mockAccount);
      expect(result).toEqual({});
      expect(mockPromptConfirm).toHaveBeenCalledWith({
        message: "Enable automatic token refresh (requires client secret and refresh token)?",
        initialValue: false
      });
    });
    it("should prompt for credentials when user accepts", async () => {
      const { promptRefreshTokenSetup } = await import("./onboarding.js");
      mockPromptConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce("secret123").mockResolvedValueOnce("refresh123");
      mockPromptText.mockResolvedValueOnce("secret123").mockResolvedValueOnce("refresh123");
      const result = await promptRefreshTokenSetup(mockPrompter, null);
      expect(result).toEqual({
        clientSecret: "secret123",
        refreshToken: "refresh123"
      });
    });
    it("should use existing values as initial prompts", async () => {
      const { promptRefreshTokenSetup } = await import("./onboarding.js");
      const accountWithRefresh = {
        ...mockAccount,
        clientSecret: "existing-secret",
        refreshToken: "existing-refresh"
      };
      mockPromptConfirm.mockResolvedValue(true);
      mockPromptText.mockResolvedValueOnce("existing-secret").mockResolvedValueOnce("existing-refresh");
      await promptRefreshTokenSetup(mockPrompter, accountWithRefresh);
      expect(mockPromptConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: true
          // Both clientSecret and refreshToken exist
        })
      );
    });
  });
  describe("configureWithEnvToken", () => {
    it("should return null when user declines env token", async () => {
      const { configureWithEnvToken } = await import("./onboarding.js");
      mockPromptConfirm.mockReset().mockResolvedValue(false);
      const result = await configureWithEnvToken(
        {},
        mockPrompter,
        null,
        "oauth:fromenv",
        false,
        {}
      );
      expect(result).toBeNull();
      expect(mockPromptText).not.toHaveBeenCalled();
    });
    it("should prompt for username and clientId when using env token", async () => {
      const { configureWithEnvToken } = await import("./onboarding.js");
      mockPromptConfirm.mockReset().mockResolvedValue(true);
      mockPromptText.mockReset().mockResolvedValueOnce("testbot").mockResolvedValueOnce("test-client-id");
      const result = await configureWithEnvToken(
        {},
        mockPrompter,
        null,
        "oauth:fromenv",
        false,
        {}
      );
      expect(result).not.toBeNull();
      expect(result?.cfg.channels?.twitch?.accounts?.default?.username).toBe("testbot");
      expect(result?.cfg.channels?.twitch?.accounts?.default?.clientId).toBe("test-client-id");
    });
  });
});
