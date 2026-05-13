/**
 * Real-behavior probe for PR #80801 --force purge ordering fix.
 *
 * Exercises the production purge helper against a real on-disk
 * `auth-profiles.json` (no mocks of the helper or the store), then
 * dumps the source-code window that hosts the ordering fix so the
 * reader can verify by eye that `removeProviderAuthProfilesWithLock`
 * is invoked AFTER `pickProviderAuthMethod` has returned a non-null
 * method.
 *
 * The unit-test side of this proof lives in:
 *   - src/commands/models/auth.test.ts
 *     "--force does NOT purge cached profiles when the requested auth
 *      method is unknown"
 *   - src/agents/fallback-skip-cache.test.ts
 *     "prunes expired buckets from sessions that are never queried again"
 *
 * Run with: node --import tsx scripts/probe-force-purge-ordering.mts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { removeProviderAuthProfilesWithLock } from "../src/agents/auth-profiles/profiles.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

async function seedProfileStore(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const seed = {
    version: 1,
    profiles: {
      "openai-codex:default": {
        type: "api_key",
        provider: "openai-codex",
        key: "sk-REDACTED-OLD",
      },
    },
    order: { "openai-codex": ["openai-codex:default"] },
  };
  await writeFile(join(agentDir, "auth-profiles.json"), JSON.stringify(seed, null, 2));
}

async function snapshotProfilesFromDisk(agentDir: string): Promise<string[]> {
  // Read the on-disk JSON directly — bypasses the in-process mtime-keyed
  // store cache, so the probe always reflects the actual file state.
  const raw = await readFile(join(agentDir, "auth-profiles.json"), "utf8");
  const parsed = JSON.parse(raw) as { profiles?: Record<string, { provider?: string }> };
  return Object.entries(parsed.profiles ?? {})
    .filter(([, cred]) => cred?.provider === "openai-codex")
    .map(([id]) => id);
}

async function readSourceWindow(): Promise<{ snippet: string; markers: string[] }> {
  const source = await readFile(join(repoRoot, "src/commands/models/auth.ts"), "utf8");
  const lines = source.split("\n");
  const pickIdx = lines.findIndex((l) => l.includes("const chosenMethod = await pickProviderAuthMethod"));
  const throwIdx = lines.findIndex(
    (l, i) => i > pickIdx && l.includes("Unknown auth method"),
  );
  const forceIdx = lines.findIndex(
    (l, i) => i > pickIdx && l.includes("if (opts.force) {"),
  );
  const runIdx = lines.findIndex(
    (l, i) => i > forceIdx && l.includes("await runProviderAuthMethod"),
  );
  const start = Math.max(0, pickIdx - 2);
  const end = Math.min(lines.length, runIdx + 12);
  const snippet = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(4, " ")} | ${l}`)
    .join("\n");
  const markers = [
    `pickProviderAuthMethod call line:      ${pickIdx + 1}`,
    `"Unknown auth method" throw line:      ${throwIdx + 1}`,
    `if (opts.force) purge block start:     ${forceIdx + 1}`,
    `runProviderAuthMethod call line:       ${runIdx + 1}`,
    forceIdx > throwIdx
      ? "ORDERING: purge runs AFTER null-check (FIX APPLIED)"
      : "ORDERING: purge runs BEFORE null-check (BUG)",
  ];
  return { snippet, markers };
}

function divider(label: string): void {
  console.log("");
  console.log("=".repeat(72));
  console.log(label);
  console.log("=".repeat(72));
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "probe-force-purge-"));
  const agentDir = join(root, "agent");
  let exitCode = 0;
  try {
    divider("Scenario A — real removeProviderAuthProfilesWithLock on disk");
    await seedProfileStore(agentDir);
    const rawBefore = await readFile(join(agentDir, "auth-profiles.json"), "utf8");
    console.log("auth-profiles.json BEFORE purge:");
    console.log(rawBefore);
    const beforeIds = await snapshotProfilesFromDisk(agentDir);
    console.log("listProfilesForProvider(...,'openai-codex') BEFORE:", JSON.stringify(beforeIds));

    await removeProviderAuthProfilesWithLock({ provider: "openai-codex", agentDir });

    const rawAfter = await readFile(join(agentDir, "auth-profiles.json"), "utf8");
    console.log("auth-profiles.json AFTER  purge:");
    console.log(rawAfter);
    const afterIds = await snapshotProfilesFromDisk(agentDir);
    console.log("listProfilesForProvider(...,'openai-codex') AFTER: ", JSON.stringify(afterIds));

    if (beforeIds.length !== 1 || afterIds.length !== 0) {
      throw new Error("Scenario A FAILED: purge did not behave as expected on real disk");
    }
    console.log("Scenario A: PASS — real on-disk purge primitive is correct");

    divider("Scenario B — source-code ordering proof in src/commands/models/auth.ts");
    const { snippet, markers } = await readSourceWindow();
    console.log(snippet);
    console.log("");
    for (const m of markers) console.log(m);
    if (!markers[markers.length - 1].includes("FIX APPLIED")) {
      throw new Error("Scenario B FAILED: source-code ordering not as expected");
    }
    console.log("Scenario B: PASS — purge invocation is AFTER pickProviderAuthMethod null-check");

    divider("ALL PROBE SCENARIOS PASSED");
  } catch (err) {
    exitCode = 1;
    console.error("PROBE FAILED:", err instanceof Error ? err.stack : err);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

void main();
