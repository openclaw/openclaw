// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/project-clone-history.mts <scratch-root>
// Warm A/A controls and interleaved baseline/candidate preparation on synthetic files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { warnIfProjectCloneShallow } from "../../src/projects/project-clone-preparation.runtime.js";
import { configureProjectCheckoutMaintenance } from "../../src/projects/project-clone-runtime.js";

assert(process.argv[2], "Supply a disposable scratch parent");
const root = await fs.mkdtemp(path.join(path.resolve(process.argv[2]), "clone-history-"));
const source = path.join(root, "source");
const base = path.join(root, "base");
const linked = path.join(root, "linked");
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const options = { env, signal: new AbortController().signal, assertCurrent() {} };
const project = { id: "synthetic", source: "cloned" as const, repoRoot: base };
const inspector = new Session();
inspector.connect();
const rows: object[] = [];
try {
  await fs.mkdir(source);
  git(source, "init", "-q", "-b", "main");
  git(source, "config", "user.name", "Synthetic Benchmark");
  git(source, "config", "user.email", "benchmark@example.invalid");
  git(source, "config", "commit.gpgsign", "false");
  git(source, "config", "uploadpack.allowFilter", "true");
  const content = Buffer.alloc(19_051, 120);
  for (let directory = 0; directory < 62; directory++) {
    const dir = path.join(source, String(directory));
    await fs.mkdir(dir);
    for (let file = 0; file < 1_000; file++) {
      await fs.writeFile(path.join(dir, `${file}.txt`), content);
    }
  }
  git(source, "add", ".");
  git(source, "commit", "-qm", "synthetic workspace");
  git(source, "commit", "--allow-empty", "-qm", "second");
  git(root, "clone", "--filter=blob:none", pathToFileURL(source).href, base);
  git(base, "worktree", "add", "--detach", linked);
  // The owner has no file or session scan: unchanged 62k-file trees stress only fixture size.
  const run = async (variant: string) => {
    global.gc?.();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.cpuUsage();
    const start = performance.now();
    if (variant === "candidate") {
      await warnIfProjectCloneShallow(base, { ...options, source: project.source });
    }
    await configureProjectCheckoutMaintenance(base, options);
    const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const allocated = (node: typeof profile.head): number =>
      node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
    rows.push({
      variant,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledAllocationBytes: allocated(profile.head),
      shallow: git(base, "rev-parse", "--is-shallow-repository"),
    });
  };
  await configureProjectCheckoutMaintenance(base, options);
  for (let i = 0; i < 5; i++) {
    await run("control-a");
    await run("control-a2");
  }
  for (let i = 0; i < 5; i++) {
    await run("baseline");
    await run("candidate");
  }
  for (let i = 0; i < 5; i++) {
    git(linked, "fetch", "--depth", "1", "origin");
    await run("baseline");
    assert.equal(git(base, "rev-parse", "--is-shallow-repository"), "true");
    await run("candidate");
    assert.equal(git(base, "rev-parse", "--is-shallow-repository"), "true");
    assert.equal(git(linked, "rev-list", "--count", "HEAD"), "1");
  }
  console.log(
    JSON.stringify(
      {
        files: 62_000,
        workspaceBytes: 62_000 * content.length,
        filesystem: process.platform,
        load: os.loadavg(),
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
