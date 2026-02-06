import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "query.ts");

describe("query script", () => {
  it("rejects non-SELECT for query command", () => {
    const r = spawnSync(
      "node",
      ["--import", "tsx", script, "query", "--sql", "INSERT INTO t VALUES (1)"],
      {
        env: { ...process.env, DATABASE_URL: "postgres://localhost/dummy" },
        encoding: "utf8",
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/only SELECT|rejected/i);
  });
});
