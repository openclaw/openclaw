/** Real removal/GC preservation proof. Synthetic --repo and --agent-db only.
 * Run unchanged A/A, then five interleaved A/B pairs, each with a fresh --output.
 * GC selection advances 25h; lease clocks/timers remain real. Baseline overlay
 * uses OPENCLAW_BENCH_BASELINE_DIR and the existing worker loader. CPU includes
 * workers, excludes Git children; allocated bytes cover the main V8 isolate.
 * --kind nested|missing|scratch selects the refusal; first-attempt and later sweeps are
 * separate. --operation remove measures repeated explicit removals instead of GC.
 * Removal acceptance: zero further attempts and lower wall/CPU/allocation after
 * the first terminal receipt; explicit retry behavior is covered by owner tests.
 * GC acceptance: preserved bytes, at most 1/3 attempts respectively,
 * zero snapshot retries after terminal preservation; no disk-reclamation claim.
 * Scratch recovery seeds an old terminal receipt and a real hardlinked local clone.
 * Acceptance: baseline retains it; candidate removes it through GC, preserves the
 * tracked snapshot, and releases the base pack's second link. The supplied large
 * agent DB is background storage shape only in this mode, never opened or copied.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    "agent-db": { type: "string" },
    kind: { type: "string", default: "missing" },
    passes: { type: "string", default: "6" },
    operation: { type: "string", default: "gc" },
  },
});
assert(values.repo && values.output && values["agent-db"]);
assert(["nested", "missing", "scratch"].includes(values.kind));
assert(values.operation === "gc" || values.operation === "remove");
assert(values.operation !== "remove" || values.kind === "nested");
const output = path.resolve(values.output);
fs.mkdirSync(output);
execFileSync("chattr", ["+C", output]);
const repo = path.join(output, "repo");
execFileSync("cp", ["-a", "--reflink=auto", values.repo, repo]);
const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
if (baseline) {
  await import("./worker-retained-heap-preload.js");
}
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) {
    delete process.env[name];
  }
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  OPENCLAW_HOME: output,
  TMPDIR: path.join(output, "tmp"),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
});
fs.mkdirSync(process.env.TMPDIR!);
const agentDir = path.join(process.env.OPENCLAW_STATE_DIR!, "agents/main/agent");
fs.mkdirSync(agentDir, { recursive: true });
execFileSync("chattr", ["+C", agentDir]);
if (values.kind !== "scratch") {
  fs.copyFileSync(
    values["agent-db"],
    path.join(agentDir, "openclaw-agent.sqlite"),
    fs.constants.COPYFILE_FICLONE_FORCE,
  );
}
const clockKey = Symbol.for("openclaw.perf.preservation-now");
let now = Date.now();
Object.defineProperty(globalThis, clockKey, { value: () => now, configurable: true });
const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const hooks = registerHooks({
  load(url, context, next) {
    if (!url.endsWith("/src/agents/worktrees/service.ts")) {
      return next(url, context);
    }
    const old = baseline && path.join(baseline, path.relative(sourceRoot, fileURLToPath(url)));
    let source = fs.readFileSync(old && fs.existsSync(old) ? old : new URL(url), "utf8");
    const start = source.indexOf("  async gc(");
    const clock = source.indexOf("const now = Date.now();", start);
    assert(clock > start && start > 0);
    source =
      source.slice(0, clock) +
      source
        .slice(clock)
        .replace(
          "const now = Date.now();",
          'const now = globalThis[Symbol.for("openclaw.perf.preservation-now")]();',
        );
    return { source, format: "module-typescript", shortCircuit: true };
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { updateRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { deferWorktreeCleanup } = await import("../../src/agents/worktrees/registry-retirement.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const config = {
  worktreeAcceleration: false,
  logging: {
    level: "info" as const,
    consoleLevel: "silent" as const,
    file: path.join(output, "runtime.log"),
  },
};
setRuntimeConfigSnapshot(config, config);
const service = new ManagedWorktreeService({ env: process.env, getConfig: () => config });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
try {
  const created = await service.create({
    repoRoot: repo,
    name: "preserved",
    ownerKind: "session",
    runSetupScript: false,
  });
  await updateRegistryWorktree(process.env, created.id, { lastActiveAt: 1 });
  const tracked = git("ls-tree", "-r", "--name-only", "HEAD")
    .split("\n")
    .find((name) => !name.startsWith("."))!;
  const payload = fs.readFileSync(path.join(created.path, tracked));
  let sharedPack: string | undefined;
  if (values.kind === "scratch") {
    git("repack", "-ad");
    const packs = path.join(repo, ".git/objects/pack");
    sharedPack = path.join(
      packs,
      fs.readdirSync(packs).find((name) => name.endsWith(".pack"))!,
    );
    const clone = path.join(created.path, ".openclaw/tmp/landing/native");
    fs.mkdirSync(path.dirname(clone), { recursive: true });
    git("clone", "--local", "--no-checkout", repo, clone);
    assert.equal(fs.statSync(sharedPack).nlink, 2);
    const observed = (await service.listRegistryRecords()).find(
      (entry) => entry.id === created.id,
    )!;
    await deferWorktreeCleanup(process.env, {
      observed,
      reason: "Checkout preserved: nested-repository; automatic retries stopped",
      retry: { stage: "nested-repository", attempts: 3, elapsedMs: 0, retryAt: null },
    });
  } else if (values.kind === "nested") {
    const nested = path.join(created.path, "inner");
    fs.mkdirSync(nested);
    execFileSync("git", ["-C", nested, "init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(nested, "valuable.txt"), "inner unsaved content\n");
  } else {
    const oid = git("rev-parse", `HEAD:${tracked}`);
    fs.unlinkSync(path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  }
  const samples = [];
  for (let pass = 0; pass < Number(values.passes); pass++) {
    now += 25 * 3600_000;
    const cpu = process.cpuUsage();
    const allocation = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocation));
    const started = performance.now();
    const outcome: Awaited<ReturnType<typeof service.remove | typeof service.gc>> | string =
      (pass === 0 && values.kind !== "scratch") || values.operation === "remove"
        ? await service
            .remove({ id: created.id, reason: "synthetic refusal" })
            .catch((error: unknown) => String(error))
        : await service.gc();
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
    const record = (await service.listRegistryRecords()).find((entry) => entry.id === created.id)!;
    if (values.kind === "scratch" && !baseline) {
      assert(record.removedAt !== undefined);
      assert(!fs.existsSync(created.path));
      assert.equal(fs.statSync(sharedPack!).nlink, 1);
      assert.deepEqual(
        execFileSync("git", ["-C", repo, "show", `${record.snapshotRef}:${tracked}`]),
        payload,
      );
    } else {
      assert.equal(record.removedAt, undefined);
      assert.deepEqual(fs.readFileSync(path.join(created.path, tracked)), payload);
    }
    if (values.kind === "nested") {
      assert.equal(
        fs.readFileSync(path.join(created.path, "inner/valuable.txt"), "utf8"),
        "inner unsaved content\n",
      );
    }
    if (!baseline && values.kind !== "scratch" && pass >= (values.kind === "nested" ? 0 : 2)) {
      assert.equal(record.gcRetry?.retryAt, null);
      if (values.operation === "remove" && pass > 0) {
        assert.equal(record.gcRetry.attempts, 1);
        assert.deepEqual(outcome, { removed: false, preserved: record.cleanup });
      }
    }
    samples.push({
      pass,
      elapsedMs,
      processCpuMs: (used.user + used.system) / 1000,
      mainAllocatedBytes: allocatedBytes,
      outcome,
      retry: record.gcRetry,
      protection: record.gcProtection,
      ...(sharedPack ? { basePackLinks: fs.statSync(sharedPack).nlink } : {}),
    });
  }
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        baseline: baseline ?? null,
        kind: values.kind,
        operation: values.operation,
        node: process.version,
        agentDbBytes: fs.statSync(values["agent-db"]).size,
        samples,
      },
      null,
      2,
    ),
  );
} finally {
  await drainGlobalSingletonLifecycleState();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, clockKey);
}
