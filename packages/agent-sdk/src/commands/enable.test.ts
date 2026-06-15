// @openclaw/agent-sdk — Unit tests for PR 4: enable + disable commands.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeAll, afterEach } from "vitest";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const PKG_SRC = PKG_ROOT;
const FIXTURES = resolve(PKG_ROOT, "__fixtures__");
const VALID_PACK = resolve(FIXTURES, "valid-pack");
const TMP = resolve(FIXTURES, "tmp");

// ── Helpers ─────────────────────────────────────────────────────────

function cleanTmp() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function runCli(args: string): string {
  return execSync(`npx tsx ${PKG_SRC}/cli.ts ${args}`, {
    encoding: "utf8",
    cwd: PKG_ROOT,
  });
}

// ── Enable command ──────────────────────────────────────────────────

describe("enable", () => {
  beforeAll(() => {
    // Generate integrity manifest for the valid-pack fixture
    if (!existsSync(resolve(VALID_PACK, "openclaw.integrity.json"))) {
      runCli(`pack ${VALID_PACK}`);
    }
  });

  describe("--dry-run", () => {
    it("shows config diff without writing", () => {
      const output = runCli(`enable ${VALID_PACK} --dry-run`);
      expect(output).toContain("dry-run");
      expect(output).toContain("Config diff:");
      expect(output).toContain("agentPackages.enabled");
    });

    it("reports file count and config changes", () => {
      const output = runCli(`enable ${VALID_PACK} --dry-run`);
      expect(output).toContain("Files to copy: 4");
    });
  });

  describe("full enable", () => {
    afterEach(cleanTmp);

    it("copies files to workspace", () => {
      const output = runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
      expect(output).toContain("Copied 4 files");
      expect(existsSync(resolve(TMP, "AGENTS.md"))).toBe(true);
      expect(existsSync(resolve(TMP, "SOUL.md"))).toBe(true);
      expect(existsSync(resolve(TMP, "USER.md"))).toBe(true);
      expect(existsSync(resolve(TMP, "HEARTBEAT.md"))).toBe(true);
    });

    it("creates config diff file", () => {
      runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
      expect(existsSync(resolve(TMP, "agent-sdk-config.json"))).toBe(true);
      const config = JSON.parse(readFileSync(resolve(TMP, "agent-sdk-config.json"), "utf8"));
      expect(config["agentPackages.enabled"]).toEqual(["test-agent"]);
    });

    it("creates registry file", () => {
      runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
      expect(existsSync(resolve(TMP, "agent-sdk-registry.json"))).toBe(true);
      const registry = JSON.parse(readFileSync(resolve(TMP, "agent-sdk-registry.json"), "utf8"));
      expect(registry["test-agent"]).toBeDefined();
      expect(registry["test-agent"].version).toBe("1.0.0");
    });

    it("creates mutable directories", () => {
      runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
      expect(existsSync(resolve(TMP, "memory"))).toBe(true);
    });

    it("succeeds with checkmark", () => {
      const output = runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
      expect(output).toContain("✓");
      expect(output).toContain("enabled");
    });
  });

  describe("validation failures", () => {
    it("fails when manifest is missing", () => {
      const emptyDir = resolve(TMP, "no-manifest");
      mkdirSync(emptyDir, { recursive: true });
      let threw = false;
      try {
        runCli(`enable ${emptyDir}`);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});

// ── Disable command ─────────────────────────────────────────────────

describe("disable", () => {
  beforeAll(() => {
    if (!existsSync(resolve(VALID_PACK, "openclaw.integrity.json"))) {
      runCli(`pack ${VALID_PACK}`);
    }
  });

  afterEach(cleanTmp);

  it("removes copied files", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    expect(existsSync(resolve(TMP, "AGENTS.md"))).toBe(true);

    const output = runCli(`disable ${VALID_PACK} --workspace ${TMP}`);
    expect(output).toContain("Removed");
    expect(existsSync(resolve(TMP, "AGENTS.md"))).toBe(false);
  });

  it("unregisters package", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    expect(existsSync(resolve(TMP, "agent-sdk-registry.json"))).toBe(true);

    const output = runCli(`disable ${VALID_PACK} --workspace ${TMP}`);
    expect(output).toContain("Unregistered");
  });

  it("removes generated config files", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    expect(existsSync(resolve(TMP, "agent-sdk-config.json"))).toBe(true);

    runCli(`disable ${VALID_PACK} --workspace ${TMP}`);
    expect(existsSync(resolve(TMP, "agent-sdk-config.json"))).toBe(false);
  });

  it("skips modified files without --force", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    writeFileSync(resolve(TMP, "AGENTS.md"), "modified content", "utf8");

    const output = runCli(`disable ${VALID_PACK} --workspace ${TMP}`);
    expect(output).toContain("Skipped");
    expect(output).toContain("AGENTS.md");
    expect(existsSync(resolve(TMP, "AGENTS.md"))).toBe(true);
  });

  it("removes modified files with --force", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    writeFileSync(resolve(TMP, "AGENTS.md"), "modified content", "utf8");

    const output = runCli(`disable ${VALID_PACK} --workspace ${TMP} --force`);
    expect(output).toContain("Force-removed");
    expect(existsSync(resolve(TMP, "AGENTS.md"))).toBe(false);
  });

  it("succeeds with checkmark", () => {
    runCli(`enable ${VALID_PACK} --workspace ${TMP}`);
    const output = runCli(`disable ${VALID_PACK} --workspace ${TMP}`);
    expect(output).toContain("✓");
    expect(output).toContain("disabled");
  });
});
