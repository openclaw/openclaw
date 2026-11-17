/** Real removal/GC preservation proof. Synthetic --repo and --agent-db only.
 * Run unchanged A/A, then five interleaved A/B pairs, each with a fresh --output.
 * GC selection advances 25h; lease clocks/timers remain real. Baseline overlay
 * uses OPENCLAW_BENCH_BASELINE_DIR and the existing worker loader. CPU includes
 * workers, excludes Git children; allocated bytes cover the main V8 isolate.
 * --kind nested|missing selects the refusal; first-attempt and later sweeps are
 * separate. Acceptance: preserved bytes, at most 1/3 attempts respectively,
 * zero snapshot retries after terminal preservation; no disk-reclamation claim.
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
  },
});
assert(values.repo && values.output && values["agent-db"]);
assert(values.kind === "nested" || values.kind === "missing");
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
fs.copyFileSync(
  values["agent-db"],
  path.join(agentDir, "openclaw-agent.sqlite"),
  fs.constants.COPYFILE_FICLONE_FORCE,
);
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
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
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
  if (values.kind === "nested") {
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
    const outcome =
      pass === 0
        ? await service
            .remove({ id: created.id, reason: "synthetic refusal" })
            .catch((error: unknown) => String(error))
        : await service.gc();
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
    const record = (await service.listRegistryRecords()).find((entry) => entry.id === created.id)!;
    assert.equal(record.removedAt, undefined);
    assert.deepEqual(fs.readFileSync(path.join(created.path, tracked)), payload);
    if (values.kind === "nested") {
      assert.equal(
        fs.readFileSync(path.join(created.path, "inner/valuable.txt"), "utf8"),
        "inner unsaved content\n",
      );
    }
    if (!baseline && pass >= (values.kind === "nested" ? 0 : 2)) {
      assert.equal(record.gcRetry?.retryAt, null);
    }
    samples.push({
      pass,
      elapsedMs,
      processCpuMs: (used.user + used.system) / 1000,
      mainAllocatedBytes: allocatedBytes,
      outcome,
      retry: record.gcRetry,
      protection: record.gcProtection,
    });
  }
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        baseline: baseline ?? null,
        kind: values.kind,
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
