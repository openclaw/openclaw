/**
 * Tests for Nostr Profile HTTP Handler
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createNostrProfileHttpHandler,
  type NostrProfileHttpContext,
} from "./nostr-profile-http.js";

// Mock the channel exports
vi.mock("./channel.js", () => ({
  publishNostrProfile: vi.fn(),
  getNostrProfileState: vi.fn(),
}));

// Mock the import module
vi.mock("./nostr-profile-import.js", () => ({
  importProfileFromRelays: vi.fn(),
  mergeProfiles: vi.fn((local, imported) => ({ ...imported, ...local })),
}));

import { publishNostrProfile, getNostrProfileState } from "./channel.js";
import { importProfileFromRelays } from "./nostr-profile-import.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createMockRequest(
  method: string,
  url: string,
  body?: unknown,
  opts?: { headers?: Record<string, string>; remoteAddress?: string },
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: opts?.remoteAddress ?? "127.0.0.1",
    configurable: true,
  });
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost:3000", ...(opts?.headers ?? {}) };

  if (body) {
    const bodyStr = JSON.stringify(body);
    process.nextTick(() => {
      req.emit("data", Buffer.from(bodyStr));
      req.emit("end");
    });
  } else {
    process.nextTick(() => {
      req.emit("end");
    });
  }

  return req;
}

function createMockResponse(): ServerResponse & {
  _getData: () => string;
  _getStatusCode: () => number;
} {
  const res = new ServerResponse({} as IncomingMessage);

  let data = "";
  let statusCode = 200;

  res.write = function (chunk: unknown) {
    data += String(chunk);
    return true;
  };

  res.end = function (chunk?: unknown) {
    if (chunk) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      data += String(chunk);
    }
    return this;
  };

  Object.defineProperty(res, "statusCode", {
    get: () => statusCode,
    set: (code: number) => {
      statusCode = code;
    },
  });

  (res as unknown as { _getData: () => string })._getData = () => data;
  (res as unknown as { _getStatusCode: () => number })._getStatusCode = () => statusCode;

  return res as ServerResponse & { _getData: () => string; _getStatusCode: () => number };
}

function createMockContext(overrides?: Partial<NostrProfileHttpContext>): NostrProfileHttpContext {
  return {
    getConfigProfile: vi.fn().mockReturnValue(undefined),
    updateConfigProfile: vi.fn().mockResolvedValue(undefined),
    getAccountInfo: vi.fn().mockReturnValue({
      pubkey: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
      relays: ["wss://relay.damus.io"],
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("nostr-profile-http", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("route matching", () => {
    it("returns false for non-nostr paths", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("GET", "/api/channels/telegram/profile");
      const res = createMockResponse();

      const result = await handler(req, res);

      expect(result).toBe(false);
    });

    it("returns false for paths without accountId", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("GET", "/api/channels/nostr/");
      const res = createMockResponse();

      const result = await handler(req, res);

      expect(result).toBe(false);
    });

    it("handles /api/channels/nostr/:accountId/profile", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("GET", "/api/channels/nostr/default/profile");
      const res = createMockResponse();

      vi.mocked(getNostrProfileState).mockResolvedValue(null);

      const result = await handler(req, res);

      expect(result).toBe(true);
    });
  });

  describe("GET /api/channels/nostr/:accountId/profile", () => {
    it("returns profile and publish state", async () => {
      const ctx = createMockContext({
        getConfigProfile: vi.fn().mockReturnValue({
          name: "testuser",
          displayName: "Test User",
        }),
      });
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("GET", "/api/channels/nostr/default/profile");
      const res = createMockResponse();

      vi.mocked(getNostrProfileState).mockResolvedValue({
        lastPublishedAt: 1234567890,
        lastPublishedEventId: "abc123",
        lastPublishResults: { "wss://relay.damus.io": "ok" },
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(true);
      expect(data.profile.name).toBe("testuser");
      expect(data.publishState.lastPublishedAt).toBe(1234567890);
    });
  });

  describe("PUT /api/channels/nostr/:accountId/profile", () => {
    it("validates profile and publishes", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("PUT", "/api/channels/nostr/default/profile", {
        name: "satoshi",
        displayName: "Satoshi Nakamoto",
        about: "Creator of Bitcoin",
      });
      const res = createMockResponse();

      vi.mocked(publishNostrProfile).mockResolvedValue({
        eventId: "event123",
        createdAt: 1234567890,
        successes: ["wss://relay.damus.io"],
        failures: [],
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(true);
      expect(data.eventId).toBe("event123");
      expect(data.successes).toContain("wss://relay.damus.io");
      expect(data.persisted).toBe(true);
      expect(ctx.updateConfigProfile).toHaveBeenCalled();
    });

    it("rejects profile mutation from non-loopback remote address", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest(
        "PUT",
        "/api/channels/nostr/default/profile",
        { name: "attacker" },
        { remoteAddress: "198.51.100.10" },
      );
      const res = createMockResponse();

      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects cross-origin profile mutation attempts", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest(
        "PUT",
        "/api/channels/nostr/default/profile",
        { name: "attacker" },
        { headers: { origin: "https://evil.example" } },
      );
      const res = createMockResponse();

      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects private IP in picture URL (SSRF protection)", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("PUT", "/api/channels/nostr/default/profile", {
        name: "hacker",
        picture: "https://127.0.0.1/evil.jpg",
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(false);
      expect(data.error).toContain("private");
    });

    it("rejects non-https URLs", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("PUT", "/api/channels/nostr/default/profile", {
        name: "test",
        picture: "http://example.com/pic.jpg",
      });
      const res = createMockResponse();

      await handler(req, res);

      expect(res._getStatusCode()).toBe(400);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(false);
      // The schema validation catches non-https URLs before SSRF check
      expect(data.error).toBe("Validation failed");
      expect(data.details).toBeDefined();
      expect(data.details.some((d: string) => d.includes("https"))).toBe(true);
    });

    it("does not persist if all relays fail", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("PUT", "/api/channels/nostr/default/profile", {
        name: "test",
      });
      const res = createMockResponse();

      vi.mocked(publishNostrProfile).mockResolvedValue({
        eventId: "event123",
        createdAt: 1234567890,
        successes: [],
        failures: [{ relay: "wss://relay.damus.io", error: "timeout" }],
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.persisted).toBe(false);
      expect(ctx.updateConfigProfile).not.toHaveBeenCalled();
    });

    it("enforces rate limiting", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);

      vi.mocked(publishNostrProfile).mockResolvedValue({
        eventId: "event123",
        createdAt: 1234567890,
        successes: ["wss://relay.damus.io"],
        failures: [],
      });

      // Make 6 requests (limit is 5/min)
      for (let i = 0; i < 6; i++) {
        const req = createMockRequest("PUT", "/api/channels/nostr/rate-test/profile", {
          name: `user${i}`,
        });
        const res = createMockResponse();
        await handler(req, res);

        if (i < 5) {
          expect(res._getStatusCode()).toBe(200);
        } else {
          expect(res._getStatusCode()).toBe(429);
          const data = JSON.parse(res._getData());
          expect(data.error).toContain("Rate limit");
        }
      }
    });
  });

  describe("POST /api/channels/nostr/:accountId/profile/import", () => {
    it("imports profile from relays", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("POST", "/api/channels/nostr/default/profile/import", {});
      const res = createMockResponse();

      vi.mocked(importProfileFromRelays).mockResolvedValue({
        ok: true,
        profile: {
          name: "imported",
          displayName: "Imported User",
        },
        event: {
          id: "evt123",
          pubkey: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
          created_at: 1234567890,
        },
        relaysQueried: ["wss://relay.damus.io"],
        sourceRelay: "wss://relay.damus.io",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.ok).toBe(true);
      expect(data.imported.name).toBe("imported");
      expect(data.saved).toBe(false); // autoMerge not requested
    });

    it("rejects import mutation from non-loopback remote address", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {},
        { remoteAddress: "203.0.113.10" },
      );
      const res = createMockResponse();

      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
    });

    it("rejects cross-origin import mutation attempts", async () => {
      const ctx = createMockContext();
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest(
        "POST",
        "/api/channels/nostr/default/profile/import",
        {},
        { headers: { origin: "https://evil.example" } },
      );
      const res = createMockResponse();

      await handler(req, res);
      expect(res._getStatusCode()).toBe(403);
    });

    it("auto-merges when requested", async () => {
      const ctx = createMockContext({
        getConfigProfile: vi.fn().mockReturnValue({ about: "local bio" }),
      });
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("POST", "/api/channels/nostr/default/profile/import", {
        autoMerge: true,
      });
      const res = createMockResponse();

      vi.mocked(importProfileFromRelays).mockResolvedValue({
        ok: true,
        profile: {
          name: "imported",
          displayName: "Imported User",
        },
        event: {
          id: "evt123",
          pubkey: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
          created_at: 1234567890,
        },
        relaysQueried: ["wss://relay.damus.io"],
        sourceRelay: "wss://relay.damus.io",
      });

      await handler(req, res);

      expect(res._getStatusCode()).toBe(200);
      const data = JSON.parse(res._getData());
      expect(data.saved).toBe(true);
      expect(ctx.updateConfigProfile).toHaveBeenCalled();
    });

    it("returns error when account not found", async () => {
      const ctx = createMockContext({
        getAccountInfo: vi.fn().mockReturnValue(null),
      });
      const handler = createNostrProfileHttpHandler(ctx);
      const req = createMockRequest("POST", "/api/channels/nostr/unknown/profile/import", {});
      const res = createMockResponse();

      await handler(req, res);

      expect(res._getStatusCode()).toBe(404);
      const data = JSON.parse(res._getData());
      expect(data.error).toContain("not found");
    });
  });
});
