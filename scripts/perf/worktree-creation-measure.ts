/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-creation-measure.ts \
 *   --repo <task-owned-clone> --output <new-directory> --samples 5
 * Run serial AB/BA arms from the respective source revisions, ten creations per
 * revision. The repository must be a disposable local clone; refs and worktrees
 * are created only there and below output. No network fetch, hooks or setup code.
 * Each creation uses the real service, state leases, Git workers and native Git.
 * Workers drain between samples to model infrequent fresh-session creation.
 * Source-loader startup precedes timing; worker startup is included. Owner logs
 * report inclusive preparation phases; Git and worker timings are also inclusive.
 * CPU/allocation cover the main JS thread, excluding workers and Git children.
 * Acceptance: same checkout commit/files, one fewer cold object census, lower
 * owner CPU/allocation, no material creation regression with matched controls.
 * Small samples describe latency, never establish p99. This is not Gateway load.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
const repo = await fs.realpath(values.repo);
const output = path.resolve(values.output);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
await fs.mkdir(output);
await fs.mkdir(path.join(output, "tmp"));
// Never inherit Git redirects, credentials, configuration or trace destinations.
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("GIT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  OPENCLAW_HOME: output,
  TMPDIR: path.join(output, "tmp"),
  XDG_CONFIG_HOME: path.join(output, "config"),
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_ATTR_NOSYSTEM: "1",
});
const key = Symbol.for("openclaw.perf.worktree-creation");
let gitTimings: Record<string, { count: number; elapsedMs: number }> = {};
let workerTimings: Record<string, { count: number; elapsedMs: number }> = {};
const record = (target: typeof gitTimings, name: string, elapsedMs: number) => {
  const entry = (target[name] ??= { count: 0, elapsedMs: 0 });
  entry.count++;
  entry.elapsedMs += elapsedMs;
};
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: (args: string[]) => {
    let index = 0;
    while (args[index] === "-c" || args[index] === "--git-dir") {
      index += 2;
    }
    const command = args[index] === "worktree" ? `worktree.${args[index + 1]}` : args[index];
    const start = performance.now();
    return () => record(gitTimings, command ?? "unknown", performance.now() - start);
  },
});
const hooks = registerHooks({
  load(url, context, next) {
    if (!url.endsWith("/src/infra/git-exec.ts")) {
      return next(url, context);
    }
    let source = readFileSync(new URL(url), "utf8");
    for (const name of [
      "executeGitCommand",
      "executeGitCommandBytes",
      "executeGitCommandBuffered",
    ]) {
      const declaration = `export async function ${name}(`;
      assert(source.includes(declaration));
      source = source.replace(declaration, `async function ${name}Measured(`);
      source += `\nexport async function ${name}(...args: Parameters<typeof ${name}Measured>) {
        const finish = globalThis[Symbol.for("openclaw.perf.worktree-creation")](args[1]);
        try { return await ${name}Measured(...args); } finally { finish(); }
      }\n`;
    }
    return { format: "module-typescript", shortCircuit: true, source };
  },
});
const diagnostics = channel("openclaw.git.operation");
const observe = (message: unknown) => {
  const event = message as { operation: string; elapsedMs: number };
  record(workerTimings, event.operation, event.elapsedMs);
};
diagnostics.subscribe(observe);
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const config = {
  logging: {
    level: "info" as const,
    consoleLevel: "info" as const,
    file: path.join(output, "runtime.log"),
  },
};
setRuntimeConfigSnapshot(config, config);
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { requireGit } = await import("../../src/agents/worktrees/git.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const commit = await requireGit(repo, ["rev-parse", "HEAD"]);
const ownerSha256 = createHash("sha256")
  .update(
    await fs.readFile(new URL("../../src/agents/worktrees/capacity.runtime.ts", import.meta.url)),
  )
  .digest("hex");
const rows = [];
try {
  for (let index = 0; index < samples; index++) {
    gitTimings = {};
    workerTimings = {};
    const service = new ManagedWorktreeService({ getConfig: () => config });
    const loadBefore = loadavg();
    const cpu = process.threadCpuUsage();
    const allocated = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocated), "Runtime must expose exact V8 allocation counters");
    const start = performance.now();
    let promptReadyMs: number | undefined;
    const created = await service.create({
      repoRoot: repo,
      name: `measure-${path.basename(output)}-${index}`,
      baseRef: commit,
      ownerKind: "session",
      ownerId: `synthetic-${index}`,
      runSetupScript: false,
      provisionIgnoredFiles: false,
      onPromptReady: async () => {
        promptReadyMs = performance.now() - start;
      },
    });
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const row = {
      index,
      ownerSha256,
      elapsedMs,
      promptReadyMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
      gitTimings: structuredClone(gitTimings),
      workerTimings: structuredClone(workerTimings),
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
    };
    assert.equal(await requireGit(created.path, ["rev-parse", "HEAD"]), commit);
    assert.equal(await requireGit(created.path, ["status", "--porcelain"]), "");
    rows.push(row);
    console.log(JSON.stringify(row));
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify(rows, null, 2));
    await drainGlobalSingletonLifecycleState();
  }
} finally {
  await drainGlobalSingletonLifecycleState();
  diagnostics.unsubscribe(observe);
  hooks.deregister();
  Reflect.deleteProperty(globalThis, key);
}
