/**
 * Tests for token manager.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTokenManager,
  clearAllTokens,
  invalidateToken,
} from "./token-manager.js";

describe("TokenManager", () => {
  const mockOpts = {
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    apiBase: "https://api.dingtalk.com",
  };

  const mockTokenResponse = {
    accessToken: "mock-access-token-12345",
    expireIn: 7200,
  };

  beforeEach(() => {
    clearAllTokens();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getToken", () => {
    it("fetches new token when cache is empty", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse),
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);
      const token = await manager.getToken();

      expect(token).toBe("mock-access-token-12345");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.dingtalk.com/v1.0/oauth2/accessToken",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
    });

    it("returns cached token on subsequent calls", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse),
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      const token1 = await manager.getToken();
      const token2 = await manager.getToken();

      expect(token1).toBe(token2);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent requests", async () => {
      let resolveFirst: (value: unknown) => void;
      const mockFetch = vi.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      // Start two concurrent requests
      const promise1 = manager.getToken();
      const promise2 = manager.getToken();

      // Resolve the fetch
      resolveFirst!({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse),
      });

      const [token1, token2] = await Promise.all([promise1, promise2]);

      expect(token1).toBe("mock-access-token-12345");
      expect(token2).toBe("mock-access-token-12345");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws error on HTTP failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      await expect(manager.getToken()).rejects.toThrow(/Failed to get access token.*401/);
    });

    it("throws error when accessToken is missing in response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ expireIn: 7200 }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      await expect(manager.getToken()).rejects.toThrow(/missing accessToken/);
    });

    it("uses default TTL when expireIn is not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ accessToken: "token-no-expire" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);
      const token = await manager.getToken();

      expect(token).toBe("token-no-expire");
    });
  });

  describe("invalidate", () => {
    it("forces refresh on next getToken call", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "token-1", expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "token-2", expireIn: 7200 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      const token1 = await manager.getToken();
      expect(token1).toBe("token-1");

      manager.invalidate();

      const token2 = await manager.getToken();
      expect(token2).toBe("token-2");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("clearAllTokens", () => {
    it("clears all cached tokens", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "token-1", expireIn: 7200 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ accessToken: "token-2", expireIn: 7200 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      await manager.getToken();
      clearAllTokens();
      const token2 = await manager.getToken();

      expect(token2).toBe("token-2");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("invalidateToken", () => {
    it("invalidates token for specific clientId", async () => {
      const mockFetch = vi.fn()
        .mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ accessToken: "new-token", expireIn: 7200 }),
        });
      vi.stubGlobal("fetch", mockFetch);

      const manager = createTokenManager(mockOpts);

      await manager.getToken();
      mockFetch.mockClear();

      invalidateToken("test-client-id");

      await manager.getToken();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("with logger", () => {
    it("logs debug messages", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockTokenResponse),
      });
      vi.stubGlobal("fetch", mockFetch);

      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
      };

      const manager = createTokenManager({ ...mockOpts, logger });
      await manager.getToken();

      expect(logger.debug).toHaveBeenCalled();
    });

    it("logs error on failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server Error"),
      });
      vi.stubGlobal("fetch", mockFetch);

      const logger = {
        debug: vi.fn(),
        error: vi.fn(),
      };

      const manager = createTokenManager({ ...mockOpts, logger });

      await expect(manager.getToken()).rejects.toThrow();
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
