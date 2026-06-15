import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySqlConfig } from "./types.js";

const { mockExecuteQuery } = vi.hoisted(() => ({
  mockExecuteQuery: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
}));

vi.mock("./mysql-client.js", () => ({
  executeQuery: mockExecuteQuery,
}));

const { LegalAuthResolver } = await import("./legal-auth-resolver.js");

const DB: MySqlConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "secret",
  database: "superworker",
};

/** Route the mock by which table the SQL touches. */
function route(opts: { hasGrant: boolean; su: number | null }) {
  mockExecuteQuery.mockImplementation(async (_config: unknown, rawSql: unknown) => {
    const sql = String(rawSql);
    if (sql.includes("entity_auth")) {
      return opts.hasGrant ? [{ ok: 1 }] : [];
    }
    if (sql.includes("legal_user_role")) {
      return opts.su === null ? [] : [{ su: opts.su }];
    }
    return [];
  });
}

describe("LegalAuthResolver.getAccess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("grants access and superuser when both rows are present", async () => {
    route({ hasGrant: true, su: 1 });
    const access = await new LegalAuthResolver(DB).getAccess("1749");
    expect(access).toEqual({ authorized: true, isSuperUser: true });
  });

  it("denies access when there is no Legal grant", async () => {
    route({ hasGrant: false, su: 0 });
    const access = await new LegalAuthResolver(DB).getAccess("1749");
    expect(access.authorized).toBe(false);
  });

  it("treats a missing legal_user_role row as non-superuser", async () => {
    route({ hasGrant: true, su: null });
    const access = await new LegalAuthResolver(DB).getAccess("1749");
    expect(access).toEqual({ authorized: true, isSuperUser: false });
  });

  it("returns empty access for a blank userId without querying", async () => {
    const access = await new LegalAuthResolver(DB).getAccess("");
    expect(access).toEqual({ authorized: false, isSuperUser: false });
    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  it("caches within the TTL (no second round of queries)", async () => {
    route({ hasGrant: true, su: 0 });
    const resolver = new LegalAuthResolver(DB);
    await resolver.getAccess("1749");
    const callsAfterFirst = mockExecuteQuery.mock.calls.length;
    await resolver.getAccess("1749");
    expect(mockExecuteQuery.mock.calls.length).toBe(callsAfterFirst);
  });

  it("serves a stale entry when a later refresh fails", async () => {
    route({ hasGrant: true, su: 1 });
    const resolver = new LegalAuthResolver(DB);
    await resolver.getAccess("1749");

    vi.advanceTimersByTime(6 * 60 * 1000); // past the 5-min TTL
    mockExecuteQuery.mockRejectedValue(new Error("db down"));
    const access = await resolver.getAccess("1749");
    expect(access).toEqual({ authorized: true, isSuperUser: true });
  });

  it("throws when the first resolution fails with no cache to fall back on", async () => {
    mockExecuteQuery.mockRejectedValue(new Error("db down"));
    await expect(new LegalAuthResolver(DB).getAccess("1749")).rejects.toThrow(
      /infringement access/,
    );
  });
});
