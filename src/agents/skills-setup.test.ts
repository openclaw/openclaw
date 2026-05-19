import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { runSkillSetupHook } from "./skills-setup.js";

const tempDirs = createTrackedTempDirs();

function writeSkillMd(dir: string, content: string, filename = "SKILL.md"): string {
  const filePath = path.join(dir, filename);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeScript(dir: string, relPath: string, content: string): string {
  const scriptPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, content, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

const PLAIN_SKILL_MD = [
  "---",
  "name: Test Skill",
  "description: A test skill.",
  "---",
  "",
  "# Test",
].join("\n");

function setupSkillMd(script: string, timeoutMs?: number): string {
  const timeout = timeoutMs ? `,"timeoutMs":${timeoutMs}` : "";
  const metadata = JSON.stringify({
    openclaw: {
      setup: { script, ...(timeoutMs ? { timeoutMs } : {}) },
    },
  });
  return [
    "---",
    "name: Test Skill",
    "description: A test skill.",
    `metadata: '${metadata}'`,
    "---",
    "",
    "# Test",
  ].join("\n");
}

function setupSkillMdWithEnv(script: string, envVars: string[]): string {
  const metadata = JSON.stringify({
    openclaw: {
      setup: { script },
      requires: { env: envVars },
    },
  });
  return [
    "---",
    "name: Test Skill",
    "description: A test skill.",
    `metadata: '${metadata}'`,
    "---",
    "",
    "# Test",
  ].join("\n");
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runSkillSetupHook", () => {
  it("returns ok when targetDir has no SKILL.md", async () => {
    const dir = await tempDirs.make("openclaw-setup-no-skillmd-");
    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when SKILL.md has no setup config", async () => {
    const dir = await tempDirs.make("openclaw-setup-no-config-");
    writeSkillMd(dir, PLAIN_SKILL_MD);
    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok when SKILL.md is found via case-insensitive lookup (skill.md)", async () => {
    const dir = await tempDirs.make("openclaw-setup-case-");
    writeSkillMd(dir, PLAIN_SKILL_MD, "skill.md");
    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("runs setup script successfully on install", async () => {
    const dir = await tempDirs.make("openclaw-setup-install-");
    writeSkillMd(dir, setupSkillMd("scripts/setup.sh"));
    writeScript(dir, "scripts/setup.sh", '#!/bin/sh\necho "setup done"\n');

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("runs setup script successfully on update", async () => {
    const dir = await tempDirs.make("openclaw-setup-update-");
    writeSkillMd(dir, setupSkillMd("scripts/setup.sh"));
    writeScript(dir, "scripts/setup.sh", '#!/bin/sh\necho "update setup done"\n');

    const result = await runSkillSetupHook({ targetDir: dir, mode: "update" });
    expect(result).toEqual({ ok: true });
  });

  it("passes SKILL_DIR and OPENCLAW_HOOK_KIND env vars", async () => {
    const dir = await tempDirs.make("openclaw-setup-env-vars-");
    writeSkillMd(dir, setupSkillMd("scripts/check-env.sh"));
    writeScript(
      dir,
      "scripts/check-env.sh",
      [
        "#!/bin/sh",
        `test "$SKILL_DIR" = "${path.resolve(dir)}" || exit 1`,
        `test "$OPENCLAW_HOOK_KIND" = "install" || exit 1`,
      ].join("\n"),
    );

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("passes requires.env vars from process.env", async () => {
    const dir = await tempDirs.make("openclaw-setup-req-env-");
    writeSkillMd(dir, setupSkillMdWithEnv("scripts/check-req-env.sh", ["MY_TOKEN", "MY_KEY"]));
    writeScript(
      dir,
      "scripts/check-req-env.sh",
      [
        "#!/bin/sh",
        'test "$MY_TOKEN" = "test-token-value" || exit 1',
        'test "$MY_KEY" = "test-key-value" || exit 1',
      ].join("\n"),
    );

    const prevToken = process.env.MY_TOKEN;
    const prevKey = process.env.MY_KEY;
    process.env.MY_TOKEN = "test-token-value";
    process.env.MY_KEY = "test-key-value";
    try {
      const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
      expect(result).toEqual({ ok: true });
    } finally {
      if (prevToken === undefined) {
        delete process.env.MY_TOKEN;
      } else {
        process.env.MY_TOKEN = prevToken;
      }
      if (prevKey === undefined) {
        delete process.env.MY_KEY;
      } else {
        process.env.MY_KEY = prevKey;
      }
    }
  });

  it("fails when setup script exits with non-zero code", async () => {
    const dir = await tempDirs.make("openclaw-setup-fail-");
    writeSkillMd(dir, setupSkillMd("scripts/fail.sh"));
    writeScript(dir, "scripts/fail.sh", '#!/bin/sh\necho "something broke"\nexit 2\n');

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toMatchObject({ ok: false, failureKind: "setup-failed" });
    if (!result.ok) {
      expect(result.error).toContain("exited with code 2");
    }
  });

  it("fails when setup script times out", async () => {
    const dir = await tempDirs.make("openclaw-setup-timeout-");
    writeSkillMd(dir, setupSkillMd("scripts/slow.sh", 500));
    writeScript(dir, "scripts/slow.sh", "#!/bin/sh\nsleep 10\n");

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toMatchObject({ ok: false, failureKind: "timeout" });
    if (!result.ok) {
      expect(result.error).toContain("timed out");
    }
  });

  it("rejects setup when script path contains ..", async () => {
    const dir = await tempDirs.make("openclaw-setup-dotdot-");
    writeSkillMd(dir, setupSkillMd("../outside.sh"));

    // resolveSetupSpec rejects ".." paths, so setup is treated as absent.
    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("fails when setup script does not exist", async () => {
    const dir = await tempDirs.make("openclaw-setup-missing-");
    writeSkillMd(dir, setupSkillMd("scripts/nonexistent.sh"));

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toMatchObject({ ok: false, failureKind: "setup-failed" });
    if (!result.ok) {
      expect(result.error).toContain("not found");
    }
  });

  it("runs non-executable script with sh fallback", async () => {
    const dir = await tempDirs.make("openclaw-setup-noexec-");
    writeSkillMd(dir, setupSkillMd("scripts/plain.sh"));
    const scriptDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, "plain.sh"), '#!/bin/sh\necho "ran via sh"\n', "utf8");
    // File exists but is not executable (default 0o644)

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("caps timeout at MAX_SETUP_TIMEOUT_MS", async () => {
    const dir = await tempDirs.make("openclaw-setup-cap-");
    // Request 10 minutes but should be capped at 300s; script exits immediately.
    writeSkillMd(dir, setupSkillMd("scripts/fast.sh", 600_000));
    writeScript(dir, "scripts/fast.sh", "#!/bin/sh\necho done\n");

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });

  it("uses default timeoutMs when not specified", async () => {
    const dir = await tempDirs.make("openclaw-setup-default-");
    writeSkillMd(dir, setupSkillMd("scripts/fast.sh"));
    writeScript(dir, "scripts/fast.sh", "#!/bin/sh\necho done\n");

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toEqual({ ok: true });
  });
});
