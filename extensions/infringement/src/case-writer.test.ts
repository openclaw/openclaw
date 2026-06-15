import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MySqlConfig } from "./types.js";

const { mockWithWriteTransaction } = vi.hoisted(() => ({
  mockWithWriteTransaction: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("./mysql-client.js", () => ({
  withWriteTransaction: mockWithWriteTransaction,
}));

const { createCaseWithLinks } = await import("./case-writer.js");

const DB: MySqlConfig = {
  host: "127.0.0.1",
  port: 3306,
  user: "writer",
  password: "secret",
  database: "superworker",
};

interface ExecCall {
  sql: string;
  values: unknown[];
}

/**
 * Install a fake transaction whose conn.execute records every statement and
 * returns insertId=42 for the case INSERT. `failCaseInsertTimes` makes the
 * first N case inserts throw ER_DUP_ENTRY to exercise the retry path.
 */
function installFakeTx(opts: { failCaseInsertTimes?: number } = {}) {
  const calls: ExecCall[] = [];
  let caseInsertAttempts = 0;
  const fails = opts.failCaseInsertTimes ?? 0;

  mockWithWriteTransaction.mockImplementation(async (_config: unknown, rawFn: unknown) => {
    const fn = rawFn as (conn: unknown) => Promise<unknown>;
    const conn = {
      execute: vi.fn(async (sql: string, values: unknown[]) => {
        if (sql.includes("INSERT INTO infringement_case")) {
          caseInsertAttempts += 1;
          if (caseInsertAttempts <= fails) {
            throw Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" });
          }
          calls.push({ sql, values });
          return [{ insertId: 42 }];
        }
        calls.push({ sql, values });
        return [{}];
      }),
    };
    return fn(conn);
  });

  return { calls, getAttempts: () => caseInsertAttempts };
}

describe("createCaseWithLinks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T08:00:00+08:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("inserts a case, its links, marks analyzing (single), and returns identifiers", async () => {
    const { calls } = installFakeTx();
    const result = await createCaseWithLinks(DB, {
      uid: 1749,
      groupId: 0,
      reporter: "举报人",
      target: "某公司",
      enterpriseType: "民企",
      links: ["https://weibo.com/x"],
    });

    expect(result.caseId).toBe(42);
    expect(result.caseNo).toMatch(/^WXB-2026-\d{4}$/);
    expect(result.linkCount).toBe(1);
    expect(result.mode).toBe("single");

    const caseInsert = calls.find((c) => c.sql.includes("INSERT INTO infringement_case"));
    expect(caseInsert?.values.slice(1, 6)).toEqual([1749, 0, "举报人", "民企", "某公司"]);

    const linkInsert = calls.find((c) => c.sql.includes("INSERT INTO infringement_link"));
    expect(linkInsert?.values).toEqual([
      42,
      "https://weibo.com/x",
      "微博",
      expect.any(Number),
      expect.any(Number),
    ]);

    const update = calls.find((c) => c.sql.includes("UPDATE infringement_case"));
    expect(update?.values.slice(0, 2)).toEqual([1, "single"]);
  });

  it("uses cluster mode and one link insert per url when ≥2 links", async () => {
    const { calls } = installFakeTx();
    const result = await createCaseWithLinks(DB, {
      uid: 1749,
      groupId: 0,
      links: ["https://weibo.com/a", "https://mp.weixin.qq.com/b"],
    });

    expect(result.mode).toBe("cluster");
    expect(result.linkCount).toBe(2);
    expect(calls.filter((c) => c.sql.includes("INSERT INTO infringement_link"))).toHaveLength(2);
  });

  it("retries case_no on a duplicate-key collision", async () => {
    const { getAttempts } = installFakeTx({ failCaseInsertTimes: 2 });
    const result = await createCaseWithLinks(DB, {
      uid: 1,
      groupId: 0,
      links: ["https://x.com/1"],
    });
    expect(getAttempts()).toBe(3); // 2 fail + 1 success
    expect(result.caseId).toBe(42);
  });
});
