/**
 * Unit tests for GenPark API Client
 *
 * Tests API client methods, error handling, and Zod schema validation.
 * Uses mocked fetch to simulate API responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GenParkClient,
  GenParkApiError,
  CircleMessageSchema,
  CircleThreadSchema,
  SkillSearchResultSchema,
  UserProfileSchema,
} from "./api-client.ts";

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

function mockFetch(response: {
  ok: boolean;
  status?: number;
  statusText?: string;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  headers?: Map<string, string>;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    statusText: response.statusText ?? (response.ok ? "OK" : "Error"),
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve("")),
    headers: {
      get: (key: string) => response.headers?.get(key) ?? null,
    },
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Zod Schema Validation
// ---------------------------------------------------------------------------

describe("Zod schemas", () => {
  it("should validate CircleMessage", () => {
    const valid = {
      id: "msg-1",
      circleId: "c-1",
      authorId: "u-1",
      authorName: "Test",
      content: "Hello",
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(CircleMessageSchema.parse(valid)).toEqual(valid);
  });

  it("should reject CircleMessage missing required fields", () => {
    expect(() => CircleMessageSchema.parse({ id: "msg-1" })).toThrow();
  });

  it("should validate SkillSearchResult", () => {
    const valid = {
      id: "skill-1",
      name: "Test Skill",
      description: "A test skill",
    };
    expect(SkillSearchResultSchema.parse(valid)).toMatchObject(valid);
  });

  it("should validate UserProfile", () => {
    const valid = {
      id: "u-1",
      username: "testuser",
    };
    expect(UserProfileSchema.parse(valid)).toMatchObject(valid);
  });
});

// ---------------------------------------------------------------------------
// GenParkApiError
// ---------------------------------------------------------------------------

describe("GenParkApiError", () => {
  it("should identify rate-limited errors", () => {
    const err = new GenParkApiError(429, "Too Many Requests", "slow down");
    expect(err.isRateLimited).toBe(true);
    expect(err.isForbidden).toBe(false);
    expect(err.isUnauthorized).toBe(false);
  });

  it("should identify forbidden errors", () => {
    const err = new GenParkApiError(403, "Forbidden", "upgrade");
    expect(err.isForbidden).toBe(true);
    expect(err.isRateLimited).toBe(false);
  });

  it("should identify unauthorized errors", () => {
    const err = new GenParkApiError(401, "Unauthorized", "bad token");
    expect(err.isUnauthorized).toBe(true);
  });

  it("should include status info in message", () => {
    const err = new GenParkApiError(500, "Internal", "oops");
    expect(err.message).toContain("500");
    expect(err.message).toContain("Internal");
    expect(err.message).toContain("oops");
  });
});

// ---------------------------------------------------------------------------
// GenParkClient — getMe
// ---------------------------------------------------------------------------

describe("GenParkClient.getMe", () => {
  it("should return user profile on success", async () => {
    const profile = { id: "u-1", username: "testuser", displayName: "Test" };
    globalThis.fetch = mockFetch({
      ok: true,
      json: () => Promise.resolve(profile),
    });

    const client = new GenParkClient({ apiToken: "test-token" });
    const result = await client.getMe();
    expect(result.id).toBe("u-1");
    expect(result.username).toBe("testuser");
  });

  it("should throw GenParkApiError on 401", async () => {
    globalThis.fetch = mockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("invalid token"),
    });

    const client = new GenParkClient({ apiToken: "bad-token" });
    await expect(client.getMe()).rejects.toThrow(GenParkApiError);
  });
});

// ---------------------------------------------------------------------------
// GenParkClient — searchSkills
// ---------------------------------------------------------------------------

describe("GenParkClient.searchSkills", () => {
  it("should return skill search results", async () => {
    const skills = [
      { id: "s-1", name: "Skill A", description: "A cool skill" },
      { id: "s-2", name: "Skill B", description: "Another skill" },
    ];
    globalThis.fetch = mockFetch({
      ok: true,
      json: () => Promise.resolve(skills),
    });

    const client = new GenParkClient({ apiToken: "test-token" });
    const result = await client.searchSkills("cool");
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("Skill A");
  });

  it("should pass query params correctly", async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = fetchMock;

    const client = new GenParkClient({ apiToken: "test-token" });
    await client.searchSkills("test", { page: 2, limit: 5, tags: ["ai"] });

    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain("q=test");
    expect(calledUrl).toContain("page=2");
    expect(calledUrl).toContain("limit=5");
    expect(calledUrl).toContain("tags=ai");
  });
});

// ---------------------------------------------------------------------------
// GenParkClient — postCircleMessage
// ---------------------------------------------------------------------------

describe("GenParkClient.postCircleMessage", () => {
  it("should send a message and return result", async () => {
    const msg = {
      id: "msg-new",
      circleId: "c-1",
      threadId: "t-1",
      authorId: "bot",
      authorName: "OpenClaw",
      content: "Reply!",
      createdAt: "2026-03-26T10:00:00Z",
    };
    globalThis.fetch = mockFetch({
      ok: true,
      json: () => Promise.resolve(msg),
    });

    const client = new GenParkClient({ apiToken: "test-token" });
    const result = await client.postCircleMessage("c-1", "t-1", "Reply!");
    expect(result.id).toBe("msg-new");
    expect(result.content).toBe("Reply!");
  });
});
