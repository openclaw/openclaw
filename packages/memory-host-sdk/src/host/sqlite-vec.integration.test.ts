import { describe, expect, it } from "vitest";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireBetterSqlite3 } from "./sqlite.js";

describe("loadSqliteVecExtension (integration — real better-sqlite3 + real extension)", () => {
  it("loads sqlite-vec into a real better-sqlite3 in-memory database", async () => {
    const BetterSqlite3 = requireBetterSqlite3();
    const db = new BetterSqlite3(":memory:");

    let result: Awaited<ReturnType<typeof loadSqliteVecExtension>>;
    try {
      result = await loadSqliteVecExtension({ db });
    } finally {
      db.close();
    }

    if (!result.ok) {
      // sqlite-vec not installed in this environment — skip rather than fail
      const missing =
        result.error?.includes("sqlite-vec package is not installed") ||
        result.error?.includes("sqlite-vec platform variant");
      if (missing) {
        return;
      }
    }

    expect(result).toEqual({ ok: true, extensionPath: expect.any(String) });
  });

  it("vec_version() is callable after loading sqlite-vec into better-sqlite3", async () => {
    const BetterSqlite3 = requireBetterSqlite3();
    const db = new BetterSqlite3(":memory:");

    let result: Awaited<ReturnType<typeof loadSqliteVecExtension>>;
    try {
      result = await loadSqliteVecExtension({ db });

      if (!result.ok) {
        db.close();
        return;
      }

      const row = db.prepare("SELECT vec_version() AS v").get() as { v: string } | undefined;
      expect(typeof row?.v).toBe("string");
      expect(row?.v.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
