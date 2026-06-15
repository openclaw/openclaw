import { afterEach, describe, expect, it, vi } from "vitest";
import type { MySqlConfig } from "./types.js";

const { mockQuery, mockExecute } = vi.hoisted(() => ({
  mockQuery: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  mockExecute: vi.fn<(...args: unknown[]) => Promise<{ insertId: number }>>(),
}));

vi.mock("./db-client.js", () => ({ query: mockQuery, execute: mockExecute }));

const { ApiKeyResolver } = await import("./key-resolver.js");

const DB: MySqlConfig = {
  host: "h",
  port: 3306,
  user: "btclaw_writer",
  password: "p",
  database: "superworker",
};

afterEach(() => vi.clearAllMocks());

describe("ApiKeyResolver.getApiKey", () => {
  it("returns the explicit override without touching the db", async () => {
    const r = new ApiKeyResolver({ "1749": "sk_override" }, DB);
    expect(await r.getApiKey("1749")).toBe("sk_override");
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("returns an existing active key from the api_key table", async () => {
    mockQuery.mockResolvedValue([{ encryptedKey: "sk_existing" }]);
    const r = new ApiKeyResolver({}, DB);
    expect(await r.getApiKey("2005")).toBe("sk_existing");
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("auto-provisions a new sk_ key when none exists, then caches it", async () => {
    mockQuery.mockResolvedValue([]); // no existing key
    mockExecute.mockResolvedValue({ insertId: 42 });
    const r = new ApiKeyResolver({}, DB);

    const key = await r.getApiKey("962");
    expect(key).toMatch(/^sk_[0-9a-f]{64}$/);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    // INSERT carries uid + a sha256 hash + the raw key
    const [, sql, params] = mockExecute.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("INSERT INTO api_key");
    expect(params[0]).toBe(962);
    expect(params[2]).toBe(key);

    // cached: a second call neither queries nor inserts again
    mockQuery.mockClear();
    mockExecute.mockClear();
    expect(await r.getApiKey("962")).toBe(key);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("de-dupes concurrent first-time resolves (single mint)", async () => {
    mockQuery.mockResolvedValue([]);
    mockExecute.mockResolvedValue({ insertId: 1 });
    const r = new ApiKeyResolver({}, DB);

    const [a, b] = await Promise.all([r.getApiKey("126"), r.getApiKey("126")]);
    expect(a).toBe(b);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("throws when there is no override and no db", async () => {
    const r = new ApiKeyResolver({}, undefined);
    await expect(r.getApiKey("2005")).rejects.toThrow(/no db/i);
  });

  it("throws for a non-numeric user id", async () => {
    const r = new ApiKeyResolver({}, DB);
    await expect(r.getApiKey("abc")).rejects.toThrow(/non-numeric/);
  });
});
