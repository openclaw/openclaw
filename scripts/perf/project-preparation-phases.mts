// node --import ./scripts/tsx.mjs scripts/perf/project-preparation-phases.mts <scratch-root>
// Five interleaved A-to-B fork refreshes per variant, warm local disk. Baseline
// replays the old checks with identical phase instrumentation. Acceptance: equal
// manifests, fewer fscks, and lower median/p95 preparation time; no AWS claim.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "../../src/gateway/worker-environments/project-preparation.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(process.argv[2]!), "phases-")));
const repository = path.join(root, "repository");
const bin = path.join(root, "bin");
fs.mkdirSync(repository);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { env, encoding: "utf8" }).trim();
git("init", "--quiet");
git("config", "user.name", "Preparation Benchmark");
git("config", "user.email", "benchmark@example.invalid");
git("config", "commit.gpgsign", "false");
fs.mkdirSync(path.join(repository, ".openclaw"));
fs.writeFileSync(path.join(repository, ".gitignore"), "node_modules/\n");
fs.writeFileSync(
  path.join(repository, ".openclaw/worktree-setup.sh"),
  "#!/bin/sh\nmkdir -p node_modules/cache\nprintf cached > node_modules/cache/input\n",
  { mode: 0o755 },
);
for (let i = 0; i < 1_000; i++) {
  fs.writeFileSync(path.join(repository, `${i}.txt`), randomBytes(32 * 1024));
}
git("add", ".");
git("commit", "--quiet", "-m", "A");
const projectA = { key: "a".repeat(64), root: repository, baseCommit: git("rev-parse", "HEAD") };
const recipe = await readWorkerProjectEnvironmentRecipe(projectA);
const template = path.join(root, "template");
fs.mkdirSync(template);

function oldChecks(script: string) {
  return script
    .replace(
      "// Completed worker-owned objects were checked on transfer; only new packs need fsck.",
      'if (verified === undefined) git(workspaceDir, ["fsck", "--full", "--strict", "--no-reflogs", baseCommit]);',
    )
    .replace(
      "previous?.baseCommit === input.baseCommit\n    ? previous.sourceManifestRef : manifest(seed, input.baseCommit, previous ? [previous.sourceManifestRef] : [])",
      "manifest(seed)",
    )
    .replace(
      "!fresh && !changed ? previous.preparedManifestRef : manifest(workspaceDir, input.baseCommit, [sourceManifestRef])",
      "manifest(workspaceDir, input.baseCommit, [sourceManifestRef])",
    );
}

async function prepare(home: string, project: typeof projectA, baseline: boolean) {
  let fscks = 0;
  const run = async (input: string) => {
    const script = baseline ? oldChecks(input) : input;
    // Count actual fsck invocations without changing their execution or result.
    const counted = script.replaceAll(
      'const result = spawnSync("git",',
      'if (args.includes("fsck")) console.error("BENCH_FSCK"); const result = spawnSync("git",',
    );
    const result = spawnSync("sh", ["-c", counted], {
      env: { ...env, HOME: home },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    fscks += result.stderr.split("BENCH_FSCK").length - 1;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const operation = createWorkerProjectPreparation({
    project,
    namespace: "benchmark",
    requireCurrent: () => {},
    setupAuthorized: true,
    preparation: {
      key: "b".repeat(64),
      cacheKey: "c".repeat(64),
      purpose: "session",
      demandAtMs: 1,
      recipe,
      setupRecipe: recipe.identity,
    },
  });
  const started = performance.now();
  try {
    const result = await operation.project.prepare({
      runScript: run,
      runScriptWithBudget: (create) => run(create(120_000)),
      upload: async (source, destination) => {
        fs.copyFileSync(source, destination);
      },
    });
    return {
      ms: performance.now() - started,
      fscks,
      phases: result.recipePreparation!.phaseDurationsMs!,
      manifest: result.preparedWorkspace!.preparedManifestRef,
    };
  } finally {
    operation.close();
  }
}

await prepare(template, projectA, false);
fs.writeFileSync(path.join(repository, "changed.txt"), "B\n");
git("add", ".");
git("commit", "--quiet", "-m", "B");
const projectB = { ...projectA, baseCommit: git("rev-parse", "HEAD") };
const samples: Record<string, Awaited<ReturnType<typeof prepare>>[]> = {
  baseline: [],
  candidate: [],
};
for (let sample = 0; sample < 5; sample++) {
  for (const variant of ["baseline", "candidate"]) {
    const home = path.join(root, `${variant}-${sample}`);
    fs.cpSync(template, home, { recursive: true, preserveTimestamps: true });
    const row = await prepare(home, projectB, variant === "baseline");
    assert.equal(row.fscks, variant === "baseline" ? 2 : 1);
    samples[variant]!.push(row);
    fs.rmSync(home, { recursive: true });
  }
}
assert.equal(
  new Set(
    Object.values(samples)
      .flat()
      .map((row) => row.manifest),
  ).size,
  1,
);
function summary(rows: number[]) {
  rows.sort((a, b) => a - b);
  return { median: rows[2], p95: rows[4], min: rows[0] };
}
const report = Object.fromEntries(
  Object.entries(samples).map(([variant, rows]) => [
    variant,
    {
      totalMs: summary(rows.map((row) => row.ms)),
      phases: Object.fromEntries(
        Object.keys(rows[0]!.phases).map((phase) => [
          phase,
          summary(rows.map((row) => (row.phases as Record<string, number>)[phase] ?? 0)),
        ]),
      ),
      samples: rows,
    },
  ]),
);
console.log(
  JSON.stringify(
    {
      workload: { files: 1_000, bytesPerFile: 32 * 1024 },
      platform: process.platform,
      node: process.version,
      loadAverage: os.loadavg(),
      report,
    },
    null,
    2,
  ),
);
fs.rmSync(root, { recursive: true });
