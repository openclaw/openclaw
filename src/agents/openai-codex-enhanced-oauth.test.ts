import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Dynamically import after mocking to ensure the module uses mocked deps
const mockRegisterOAuthProvider = vi.fn();
vi.mock("@mariozechner/pi-ai", () => ({
  registerOAuthProvider: mockRegisterOAuthProvider,
}));

describe("openai-codex-enhanced-oauth", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegisterOAuthProvider.mockReset();
  });

  describe("registerEnhancedCodexOAuth", () => {
    it("registers a custom openai-codex OAuth provider", async () => {
      const mod = await import("./openai-codex-enhanced-oauth.js");
      // Reset internal `registered` state by reimporting
      mod.registerEnhancedCodexOAuth();

      expect(mockRegisterOAuthProvider).toHaveBeenCalled();
      const provider = mockRegisterOAuthProvider.mock.calls[0]?.[0];
      expect(provider).toBeDefined();
      expect(provider.id).toBe("openai-codex");
      expect(provider.name).toContain("ChatGPT");
      expect(provider.usesCallbackServer).toBe(true);
      expect(typeof provider.login).toBe("function");
      expect(typeof provider.refreshToken).toBe("function");
      expect(typeof provider.getApiKey).toBe("function");
    });

    it("getApiKey returns access token", async () => {
      const mod = await import("./openai-codex-enhanced-oauth.js");
      mod.registerEnhancedCodexOAuth();
      const provider = mockRegisterOAuthProvider.mock.calls[0]?.[0];
      expect(provider.getApiKey({ access: "test-token", refresh: "r", expires: 0 })).toBe(
        "test-token",
      );
    });
  });

  describe("refreshOpenAICodexTokenEnhanced", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("preserves stored accountId when JWT lacks the claim", async () => {
      const mod = await import("./openai-codex-enhanced-oauth.js");

      // Mock fetch to return a token WITHOUT accountId in JWT
      const fakeJwtPayload = { sub: "user-123" };
      const fakeAccess = `header.${btoa(JSON.stringify(fakeJwtPayload))}.sig`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: fakeAccess,
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
        }),
      );

      const result = await mod.refreshOpenAICodexTokenEnhanced({
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        accountId: "stored-account-id",
      });

      expect(result.access).toBe(fakeAccess);
      expect(result.refresh).toBe("new-refresh");
      expect(result.accountId).toBe("stored-account-id");
    });

    it("uses fresh accountId when JWT contains the claim", async () => {
      const mod = await import("./openai-codex-enhanced-oauth.js");

      const fakeJwtPayload = {
        "https://api.openai.com/auth": { chatgpt_account_id: "jwt-account-id" },
      };
      const fakeAccess = `header.${btoa(JSON.stringify(fakeJwtPayload))}.sig`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: fakeAccess,
              refresh_token: "new-refresh",
              expires_in: 3600,
            }),
        }),
      );

      const result = await mod.refreshOpenAICodexTokenEnhanced({
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        accountId: "stored-account-id",
      });

      expect(result.accountId).toBe("jwt-account-id");
    });

    it("throws when token refresh HTTP request fails", async () => {
      const mod = await import("./openai-codex-enhanced-oauth.js");

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

      await expect(
        mod.refreshOpenAICodexTokenEnhanced({
          access: "old-access",
          refresh: "old-refresh",
          expires: 0,
        }),
      ).rejects.toThrow("Failed to refresh OpenAI Codex token");
    });
  });
});
