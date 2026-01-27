import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAnchorBrowserSession,
  endAnchorBrowserSession,
  getAnchorBrowserSession,
} from "./anchorbrowser.js";

describe("anchorbrowser client", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("createAnchorBrowserSession", () => {
    it("creates a session with minimal params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: "session-123",
            cdp_url: "wss://browser.anchorbrowser.io/session-123",
            live_view_url: "https://app.anchorbrowser.io/live/session-123",
          },
        }),
      });

      const session = await createAnchorBrowserSession({
        apiKey: "test-api-key",
      });

      expect(session).toEqual({
        id: "session-123",
        cdpUrl: "wss://browser.anchorbrowser.io/session-123",
        liveViewUrl: "https://app.anchorbrowser.io/live/session-123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anchorbrowser.io/v1/sessions",
        expect.objectContaining({
          method: "POST",
          headers: {
            "anchor-api-key": "test-api-key",
            "Content-Type": "application/json",
          },
        }),
      );
    });

    it("creates a session with all params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: "session-456",
            cdp_url: "wss://browser.anchorbrowser.io/session-456",
          },
        }),
      });

      const session = await createAnchorBrowserSession({
        apiKey: "test-api-key",
        apiUrl: "https://custom.api.io/v1",
        headless: true,
        viewport: { width: 1920, height: 1080 },
        proxy: { active: true, type: "anchor_residential", countryCode: "de" },
        captchaSolver: true,
        adblock: false,
        timeout: { maxDuration: 30, idleTimeout: 10 },
      });

      expect(session.id).toBe("session-456");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.api.io/v1/sessions",
        expect.objectContaining({
          method: "POST",
          body: expect.any(String),
        }),
      );

      // Parse the body to verify structure
      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body as string);
      expect(body.browser.headless).toEqual({ active: true });
      expect(body.browser.viewport).toEqual({ width: 1920, height: 1080 });
      expect(body.browser.captcha_solver).toEqual({ active: true });
      expect(body.browser.adblock).toEqual({ active: false });
      expect(body.session.proxy).toEqual({
        active: true,
        type: "anchor_residential",
        country_code: "de",
      });
      expect(body.session.timeout).toEqual({
        max_duration: 30,
        idle_timeout: 10,
      });
    });

    it("throws on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({
          error: "Invalid API key",
        }),
      });

      await expect(createAnchorBrowserSession({ apiKey: "invalid-key" })).rejects.toThrow(
        "Anchorbrowser API error: Invalid API key",
      );
    });

    it("throws on non-JSON error response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => {
          throw new Error("Not JSON");
        },
      });

      await expect(createAnchorBrowserSession({ apiKey: "test-key" })).rejects.toThrow(
        "Anchorbrowser API error: 500 Internal Server Error",
      );
    });
  });

  describe("endAnchorBrowserSession", () => {
    it("ends a session successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await endAnchorBrowserSession({
        apiKey: "test-api-key",
        sessionId: "session-123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anchorbrowser.io/v1/sessions/session-123",
        expect.objectContaining({
          method: "DELETE",
          headers: {
            "anchor-api-key": "test-api-key",
            "Content-Type": "application/json",
          },
        }),
      );
    });

    it("accepts 404 (session already ended)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      // Should not throw
      await endAnchorBrowserSession({
        apiKey: "test-api-key",
        sessionId: "session-123",
      });
    });

    it("throws on other errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({ message: "Server error" }),
      });

      await expect(
        endAnchorBrowserSession({
          apiKey: "test-api-key",
          sessionId: "session-123",
        }),
      ).rejects.toThrow("Anchorbrowser API error: Server error");
    });

    it("uses custom API URL", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      await endAnchorBrowserSession({
        apiKey: "test-api-key",
        apiUrl: "https://custom.api.io/v1",
        sessionId: "session-123",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://custom.api.io/v1/sessions/session-123",
        expect.anything(),
      );
    });
  });

  describe("getAnchorBrowserSession", () => {
    it("returns session info", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            id: "session-123",
            cdp_url: "wss://browser.anchorbrowser.io/session-123",
            live_view_url: "https://app.anchorbrowser.io/live/session-123",
          },
        }),
      });

      const session = await getAnchorBrowserSession({
        apiKey: "test-api-key",
        sessionId: "session-123",
      });

      expect(session).toEqual({
        id: "session-123",
        cdpUrl: "wss://browser.anchorbrowser.io/session-123",
        liveViewUrl: "https://app.anchorbrowser.io/live/session-123",
      });
    });

    it("returns null for 404", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const session = await getAnchorBrowserSession({
        apiKey: "test-api-key",
        sessionId: "nonexistent",
      });

      expect(session).toBeNull();
    });

    it("throws on other errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({}),
      });

      await expect(
        getAnchorBrowserSession({
          apiKey: "test-api-key",
          sessionId: "session-123",
        }),
      ).rejects.toThrow("Anchorbrowser API error: 500 Internal Server Error");
    });
  });
});
