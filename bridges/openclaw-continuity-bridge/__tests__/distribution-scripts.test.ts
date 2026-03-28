import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const syncScriptPath = join(packageRoot, "scripts", "sync-to-sidecar.mjs");
const runScriptPath = join(packageRoot, "run-continuity-bridge.sh");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("distribution scripts", () => {
  it("syncs the tracked memory-read tool test into the sidecar", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "openclaw-sync-home-"));
    tempDirs.push(tempHome);

    execFileSync("node", [syncScriptPath], {
      cwd: packageRoot,
      env: { ...process.env, HOME: tempHome },
      stdio: "pipe",
    });

    const syncedTestPath = join(
      tempHome,
      ".airya",
      "mcp",
      "__tests__",
      "memory-read-tools.test.ts",
    );
    expect(existsSync(syncedTestPath)).toBe(true);
    expect(readFileSync(syncedTestPath, "utf8")).toContain('describe("memory read tools"');
  });

  it("preserves the caller HOME when launching the sidecar runtime", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "openclaw-run-home-"));
    tempDirs.push(tempHome);

    const sidecarRoot = join(tempHome, ".airya", "mcp");
    mkdirSync(join(sidecarRoot, "dist"), { recursive: true });
    writeFileSync(
      join(sidecarRoot, "dist", "openclaw-continuity-bridge.js"),
      [
        "console.log(JSON.stringify({",
        "  cwd: process.cwd(),",
        "  home: process.env.HOME,",
        "}));",
      ].join("\n"),
      "utf8",
    );

    const output = execFileSync("bash", [runScriptPath], {
      cwd: packageRoot,
      env: { ...process.env, HOME: tempHome },
      encoding: "utf8",
      stdio: "pipe",
    });

    const payload = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as {
      cwd?: string;
      home?: string;
    };

    expect(payload.home).toBe(tempHome);
    expect(payload.cwd).toBe(realpathSync(sidecarRoot));
  });
});
