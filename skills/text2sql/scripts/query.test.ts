import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "query.ts");

function runScript(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("node", ["--import", "tsx", script, ...args], {
    env: env ?? process.env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

describe("query script", () => {
  it("exits 1 and prints DATABASE_URL message when DATABASE_URL is not set", () => {
    const envWithoutUrl = { ...process.env };
    delete envWithoutUrl.DATABASE_URL;
    const r = runScript(["list_tables"], envWithoutUrl);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DATABASE_URL/i);
  });

  it("exits 1 and prints Usage when command is invalid", () => {
    const r = runScript(["invalid_cmd"], {
      ...process.env,
      DATABASE_URL: "postgres://x/x",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Usage/i);
  });

  it("rejects non-SELECT for query command", () => {
    const r = runScript(["query", "--sql", "INSERT INTO t VALUES (1)"], {
      ...process.env,
      DATABASE_URL: "postgres://localhost/dummy",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/only SELECT|rejected/i);
  });
});
