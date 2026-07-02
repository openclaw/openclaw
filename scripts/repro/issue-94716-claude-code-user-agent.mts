#!/usr/bin/env node
import { execFileSync } from "node:child_process";
/**
 * Live repro for issue #94716: Anthropic claude-cli provider sends stale user-agent.
 *
 * Verifies that the OAuth user-agent header is built from the installed
 * `claude --version` output at runtime, not from a hardcoded "2.1.75" constant.
 *
 * Run:
 *   node --import tsx scripts/repro/issue-94716-claude-code-user-agent.mts
 */
import { chmod, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-repro-94716-"));
  const fakeBinDir = path.join(tmpDir, "bin");
  await mkdir(fakeBinDir, { recursive: true });

  // Simulate an installed Claude Code CLI version newer than the old hardcoded 2.1.75.
  const fakeVersion = "2.1.177";
  const fakeClaude = path.join(fakeBinDir, process.platform === "win32" ? "claude.cmd" : "claude");
  await writeFile(
    fakeClaude,
    process.platform === "win32"
      ? `@echo off\necho ${fakeVersion} (Claude Code)\n`
      : `#!/bin/sh\necho "${fakeVersion} (Claude Code)"\n`,
  );
  await chmod(fakeClaude, 0o755);

  const probeScript = path.join(tmpDir, "probe.mts");
  await writeFile(
    probeScript,
    `
      import { claudeCodeUserAgent } from "${path.join(repoRoot, "src/llm/utils/claude-code-version.ts").replace(/\\/g, "/")}";
      console.log(claudeCodeUserAgent());
    `,
  );

  const envPath = `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
  const output = execFileSync("node", ["--import", "tsx", probeScript], {
    cwd: repoRoot,
    env: { ...process.env, PATH: envPath },
    encoding: "utf8",
  }).trim();

  await rm(tmpDir, { recursive: true, force: true });

  console.log("=== Reproduction for issue #94716 ===");
  console.log("Installed Claude Code version (simulated via PATH):", fakeVersion);
  console.log("Resolved user-agent:", output);

  const expected = `claude-cli/${fakeVersion}`;
  if (output === expected) {
    console.log(
      "PASS: OAuth user-agent uses the installed claude-code CLI version, not a stale hardcoded value.",
    );
    return;
  }

  console.error(`FAIL: expected "${expected}", got "${output}"`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
