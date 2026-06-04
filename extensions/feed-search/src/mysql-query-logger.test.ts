import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOOK_SOURCE } from "./mysql-query-logger.js";

// Exercises the standalone hook exactly as it runs on disk: write HOOK_SOURCE to a
// .cjs file, require it, patch a fake connection class, and assert every call form
// is appended to the JSONL log while return values pass through unchanged.

describe("mysql-query-logger HOOK_SOURCE", () => {
  let dir: string;
  let logPath: string;
  let originalLogPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sqlhook-test-"));
    logPath = path.join(dir, "mysql-queries.jsonl");
    // The hook honors OPENCLAW_SQL_LOG_PATH; redirect it into the temp dir.
    originalLogPath = process.env.OPENCLAW_SQL_LOG_PATH;
    process.env.OPENCLAW_SQL_LOG_PATH = logPath;
  });

  afterEach(() => {
    if (originalLogPath === undefined) {
      delete process.env.OPENCLAW_SQL_LOG_PATH;
    } else {
      process.env.OPENCLAW_SQL_LOG_PATH = originalLogPath;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function loadHook(): (connectionClass: unknown) => void {
    const hookFile = path.join(dir, "hook.cjs");
    writeFileSync(hookFile, HOOK_SOURCE, "utf8");
    const require_ = createRequire(pathToFileURL(hookFile));
    return require_(hookFile) as (connectionClass: unknown) => void;
  }

  function readLines(): Array<Record<string, unknown>> {
    const raw = readFileSync(logPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("logs query/execute across all argument forms and preserves return values", () => {
    const patch = loadHook();
    const calls: unknown[][] = [];
    class FakeConnection {
      query(...args: unknown[]): string {
        calls.push(args);
        return "query-result";
      }
      execute(...args: unknown[]): string {
        calls.push(args);
        return "execute-result";
      }
    }
    patch(FakeConnection);

    const conn = new FakeConnection();
    expect(conn.query("SELECT 1 FROM t WHERE id = ?", [42])).toBe("query-result");
    expect(conn.execute({ sql: "SELECT * FROM feed_topic", values: [1, 2] })).toBe(
      "execute-result",
    );
    expect(conn.execute("DESCRIBE cron_tasks", () => {})).toBe("execute-result");

    // Original methods still received their arguments.
    expect(calls).toHaveLength(3);

    const lines = readLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      method: "query",
      sql: "SELECT 1 FROM t WHERE id = ?",
      params: [42],
    });
    expect(lines[1]).toMatchObject({
      method: "execute",
      sql: "SELECT * FROM feed_topic",
      params: [1, 2],
    });
    // (sql, callback) form: no params, callback must not be logged as params.
    expect(lines[2]).toMatchObject({
      method: "execute",
      sql: "DESCRIBE cron_tasks",
      params: null,
    });
    for (const line of lines) {
      expect(typeof line.ts).toBe("string");
      expect(typeof line.pid).toBe("number");
    }
  });

  it("is idempotent — patching twice does not double-log", () => {
    const patch = loadHook();
    class FakeConnection {
      query(..._args: unknown[]): string {
        return "ok";
      }
      execute(..._args: unknown[]): string {
        return "ok";
      }
    }
    patch(FakeConnection);
    patch(FakeConnection);

    const conn = new FakeConnection();
    conn.query("SELECT 1");

    expect(readLines()).toHaveLength(1);
  });
});
