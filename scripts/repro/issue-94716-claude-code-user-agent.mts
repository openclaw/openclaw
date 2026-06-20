#!/usr/bin/env node
/**
 * Live repro for issue #94716: Anthropic claude-cli provider sends stale user-agent.
 *
 * Verifies that the OAuth user-agent header is built from the installed
 * @anthropic-ai/claude-code package version at runtime, not from a hardcoded
 * "2.1.75" constant.
 *
 * Run:
 *   node --import tsx scripts/repro/issue-94716-claude-code-user-agent.mts
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

async function main() {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "openclaw-repro-94716-"));
  const fakePackageDir = path.join(tmpDir, "node_modules", "@anthropic-ai", "claude-code");
  await mkdir(fakePackageDir, { recursive: true });

  // Simulate an installed Claude Code CLI version newer than the old hardcoded 2.1.75.
  const fakeVersion = "2.1.177";
  await writeFile(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-code", version: fakeVersion }),
  );

  const probeScript = path.join(tmpDir, "probe.mts");
  await writeFile(
    probeScript,
    `
      import { claudeCodeUserAgent } from "${path.join(repoRoot, "src/llm/utils/claude-code-version.ts").replace(/\\/g, "/")}";
      console.log(claudeCodeUserAgent());
    `,
  );

  const nodePaths = [path.join(tmpDir, "node_modules"), path.join(repoRoot, "node_modules")];
  const output = execFileSync("node", ["--import", "tsx", probeScript], {
    cwd: repoRoot,
    env: { ...process.env, NODE_PATH: nodePaths.join(path.delimiter) },
    encoding: "utf8",
  }).trim();

  await rm(tmpDir, { recursive: true, force: true });

  console.log("=== Reproduction for issue #94716 ===");
  console.log("Installed Claude Code version (simulated):", fakeVersion);
  console.log("Resolved user-agent:", output);

  const expected = `claude-cli/${fakeVersion}`;
  if (output === expected) {
    console.log("PASS: OAuth user-agent uses the installed claude-code version, not a stale hardcoded value.");
    return;
  }

  console.error(`FAIL: expected "${expected}", got "${output}"`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
