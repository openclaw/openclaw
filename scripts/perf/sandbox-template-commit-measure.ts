/**
 * Real private-template owner, native clones, Git, and sandboxed pnpm installation.
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-template-commit-measure.ts \
 *   --repo <synthetic-repo> --output <new-output> --image <local-node-pnpm-image> [--fixture]
 * --baseline-dir loads frozen local-workspace-template.ts, local-workspace-checkout.ts,
 * and dependency-template.ts (the first two gateway/worker-environments, last agents/sandbox).
 * --registry uses is-number@7.0.0 and bridge networking to exercise pnpm repeat-install
 * behavior without local dependencies. --files may shrink this correctness-only fixture.
 * --contract also checks concurrent source changes and lockfile invalidation;
 * --seed-only followed by --resume --burst 20 in another process checks restart reuse.
 * --alternate [--burst 20] seeds three commits, then measures concurrent A/B/C waves.
 * Results are saved before asserting zero repeated dependency preparations.
 * Reuse the same --output; burst CPU/allocation are aggregate, not per-caller costs.
 * --profile records a separate source-change CPU profile (exclude from timing pairs).
 * Create them with git show <base>:src/gateway/worker-environments/<name>.ts.
 * Run two baseline A/A controls, then five counterbalanced baseline/candidate pairs.
 * Acceptance: same exact source and source-dependent install output; one refresh for
 * concurrent consumers, lock changes rebuild, lower owner cost; target prepare+apply
 * <10 s on source-only changes. Inclusive child phases must not be added twice.
 * Main-thread CPU/allocation exclude workers, Git, Docker, and guest processes.
 * Process CPU includes JS workers but excludes Git, Docker, and guest processes.
 * Prepare the local image from node:26.12.1-bookworm with
 * RUN npm install --global pnpm@12.15.0; builds and fixture generation are untimed.
 * The fixture has 62k tracked payload files (~1.1 GB), a real pnpm lock, and a local
 * dependency. All 62k payload blobs are distinct; group-local patterns make their
 * compression synthetic. This preserves per-object work without claiming real entropy.
 * No production state, full Gateway traffic, or 35 GiB agent database is represented.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    image: { type: "string" },
    fixture: { type: "boolean" },
    registry: { type: "boolean" },
    files: { type: "string", default: "62000" },
    profile: { type: "boolean" },
    contract: { type: "boolean" },
    "seed-only": { type: "boolean" },
    resume: { type: "boolean" },
    burst: { type: "string" },
    alternate: { type: "boolean" },
    "baseline-dir": { type: "string" },
  },
});
assert(values.repo && values.output && values.image, "--repo, --output and --image are required");
const payloadFiles = Number(values.files);
assert(
  Number.isSafeInteger(payloadFiles) && payloadFiles > 0,
  "--files must be a positive integer",
);
const repo = path.resolve(values.repo);
const output = path.resolve(values.output);
await fs.mkdir(output, { recursive: values.resume });
await fs.mkdir(path.join(output, "tmp"), { recursive: values.resume });
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
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
if (values.fixture) {
  await fs.mkdir(repo);
  const payload = Buffer.alloc(17742, 120);
  for (let i = 0; i < payloadFiles; i++) {
    const directory = path.join(repo, "src", `group-${Math.floor(i / 100)}`);
    if (i % 100 === 0) {
      await fs.mkdir(directory, { recursive: true });
      // Reproducible group-local byte diversity, without random fixture input.
      const seed = createHash("sha256")
        .update(String(Math.floor(i / 100)))
        .digest();
      for (let offset = 0; offset < payload.length; offset++) {
        payload[offset] = seed[offset % seed.length]!;
      }
    }
    payload.writeUInt32LE(i, 0);
    await fs.writeFile(path.join(directory, `file-${i}.txt`), payload);
  }
  await fs.mkdir(path.join(repo, "vendor", "dependency"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "vendor/dependency/package.json"),
    JSON.stringify({ name: "fixture-dependency", version: "1.0.0" }),
  );
  await fs.writeFile(
    path.join(repo, "vendor/dependency/index.js"),
    "module.exports = 'dependency';\n",
  );
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "sandbox-template-fixture",
      private: true,
      dependencies: values.registry
        ? { "is-number": "7.0.0" }
        : { "fixture-dependency": "file:vendor/dependency" },
      scripts: { prepare: "node prepare.cjs" },
    }),
  );
  await fs.writeFile(
    path.join(repo, "prepare.cjs"),
    "const fs = require('node:fs'); fs.writeFileSync('node_modules/source-derived.txt', fs.readFileSync('source.txt'));\n",
  );
  await fs.writeFile(path.join(repo, "source.txt"), "initial\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      values.registry ? "bridge" : "none",
      "-v",
      `${repo}:/workspace`,
      "-w",
      "/workspace",
      values.image,
      "pnpm",
      "install",
      "--lockfile-only",
      "--ignore-scripts",
    ],
    { stdio: "inherit" },
  );
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Synthetic Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "gc.auto", "0");
  git("add", ".");
  git("commit", "-qm", "initial");
  git("tag", "fixture-initial");
  for (const label of ["source-one", "source-two"]) {
    await fs.writeFile(path.join(repo, "source.txt"), `${label}\n`);
    await fs.writeFile(
      path.join(repo, "vendor/dependency/index.js"),
      `module.exports = '${label}';\n`,
    );
    git("commit", "-qam", label);
    git("tag", `fixture-${label}`);
  }
  await fs.appendFile(path.join(repo, "pnpm-lock.yaml"), "\n# changed lockfile generation\n");
  git("commit", "-qam", "lock update");
  git("tag", "fixture-lock");
  git("gc", "--quiet");
}
const instrumentation = Symbol.for("openclaw.perf.sandbox-template");
let installs = 0;
Object.defineProperty(globalThis, instrumentation, {
  configurable: true,
  value: () => {
    installs++;
  },
});
const owners = ["local-workspace-template.ts", "local-workspace-checkout.ts"];
const hooks = registerHooks({
  load(url, context, next) {
    const name = owners.find((file) => url.endsWith(`/src/gateway/worker-environments/${file}`));
    if (name && values["baseline-dir"]) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: readFileSync(path.join(values["baseline-dir"], name), "utf8"),
      };
    }
    if (url.endsWith("/src/agents/sandbox/dependency-template.ts")) {
      let source = readFileSync(
        values["baseline-dir"]
          ? path.join(values["baseline-dir"], "dependency-template.ts")
          : new URL(url),
        "utf8",
      );
      source = source.replace(
        "export async function prepareSandboxDependencyTemplate(",
        "async function measuredPrepareSandboxDependencyTemplate(",
      );
      source += `\nexport async function prepareSandboxDependencyTemplate(...args: Parameters<typeof measuredPrepareSandboxDependencyTemplate>) { globalThis[Symbol.for("openclaw.perf.sandbox-template")](); return await measuredPrepareSandboxDependencyTemplate(...args); }\n`;
      return { format: "module-typescript", shortCircuit: true, source };
    }
    return next(url, context);
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const config = {
  logging: {
    level: "info" as const,
    consoleLevel: "info" as const,
    file: path.join(output, "runtime.log"),
  },
};
setRuntimeConfigSnapshot(config, config);
const { resolveSandboxConfigForAgent } = await import("../../src/agents/sandbox/config.js");
const { cloneLocalWorkspaceTemplate } =
  await import("../../src/gateway/worker-environments/local-workspace-template.js");
const { withWorktreePreparationTiming } =
  await import("../../src/agents/worktrees/preparation-timing.js");
const { listTemplatesAsync } =
  await import("../../src/agents/worktrees/template-registry-async.js");
const { detectWorktreeFilesystemBackend } =
  await import("../../src/agents/worktrees/filesystem-backend.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { readRegistry } = await import("../../src/agents/sandbox/registry.js");
const { retireSandboxDependencyBuilder } =
  await import("../../src/agents/sandbox/dependency-template.js");
const sandbox = resolveSandboxConfigForAgent({
  agents: {
    defaults: {
      sandbox: {
        backend: "docker",
        docker: { image: values.image, user: "0:0", network: values.registry ? "bridge" : "none" },
      },
    },
  },
});
const signal = new AbortController().signal;
const guard = {
  signal,
  commitGuard: () => signal.throwIfAborted(),
  rollbackGuard: () => {},
  requireDiskSpace: async () => {},
};
const backend = await detectWorktreeFilesystemBackend(output, guard);
assert(backend, "Native filesystem acceleration is required");
const templateRoot = path.join(output, "templates");
await fs.mkdir(templateRoot, { recursive: values.resume });
const rows: object[] = [];
async function clone(label: string, ref: string, verify = true) {
  const baseCommit = git("rev-parse", ref);
  const destination = path.join(output, label);
  const inspector = values.profile && label === "source-change" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const processCpu = process.cpuUsage();
  const cpu = process.threadCpuUsage();
  const allocated = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocated), "Runtime must expose exact V8 allocation counters");
  const before = installs;
  const started = performance.now();
  const load = loadavg();
  assert(
    await withWorktreePreparationTiming("managed", () =>
      cloneLocalWorkspaceTemplate({
        source: repo,
        repoRoot: repo,
        baseCommit,
        destination,
        branch: `openclaw/${label}`,
        temporaryRoot: path.join(output, "tmp"),
        templateRoot,
        env: process.env,
        sandbox,
        guard,
      }),
    ),
  );
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const processUsed = process.cpuUsage(processCpu);
  const row = {
    label,
    elapsedMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    processCpuMs: (processUsed.user + processUsed.system) / 1000,
    mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
    installs: installs - before,
    load,
    backend: backend!.id,
    baseCommit,
  };
  if (inspector) {
    await fs.writeFile(
      path.join(output, "source-change.cpuprofile"),
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
    inspector.disconnect();
  }
  rows.push(row);
  console.log(JSON.stringify(row));
  if (verify) {
    await verifyClone(destination, baseCommit);
  }
  return destination;
}
async function verifyClone(destination: string, baseCommit: string) {
  assert.equal(
    execFileSync("git", ["-C", destination, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    baseCommit,
  );
  assert.equal(
    execFileSync("git", ["-C", destination, "status", "--porcelain"], { encoding: "utf8" }).trim(),
    "",
  );
  assert.equal(
    await fs.readFile(path.join(destination, "source.txt"), "utf8"),
    await fs.readFile(path.join(destination, "node_modules/source-derived.txt"), "utf8"),
  );
  if (values.registry) {
    const installed = JSON.parse(
      await fs.readFile(path.join(destination, "node_modules/is-number/package.json"), "utf8"),
    );
    assert.equal(installed.version, "7.0.0");
  } else {
    assert.equal(
      await fs.readFile(path.join(destination, "node_modules/fixture-dependency/index.js"), "utf8"),
      `${git("show", `${baseCommit}:vendor/dependency/index.js`)}\n`,
    );
  }
}
async function burst(label: string, ref: string, count: number) {
  const processCpu = process.cpuUsage();
  const allocated = getHeapStatistics().total_allocated_bytes;
  const before = installs;
  const started = performance.now();
  const destinations = await Promise.all(
    Array.from({ length: count }, (_, i) => clone(`${label}-${process.pid}-${i}`, ref, false)),
  );
  rows.push({
    label,
    elapsedMs: performance.now() - started,
    processCpuMs: Object.values(process.cpuUsage(processCpu)).reduce((a, b) => a + b) / 1000,
    mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
    installs: installs - before,
    ...(values.alternate ? { generations: await listTemplatesAsync(process.env) } : {}),
  });
  for (const destination of destinations) {
    await verifyClone(destination, git("rev-parse", ref));
  }
}
let alternationInstalls: number | undefined;
try {
  if (!values.resume) {
    await clone("seed", "fixture-initial");
  }
  if (values.alternate) {
    assert(!values.resume && !values["seed-only"] && !values.contract && !values.profile);
    const count = Number(values.burst ?? "3");
    assert(Number.isSafeInteger(count) && count >= 3 && count <= 100);
    await clone("seed-source-one", "fixture-source-one");
    await clone("seed-source-two", "fixture-source-two");
    rows.push({ label: "seed-generations", generations: await listTemplatesAsync(process.env) });
    const before = installs;
    for (const [index, ref] of [
      "fixture-initial",
      "fixture-source-one",
      "fixture-source-two",
    ].entries()) {
      await burst(`alternate-${index}`, ref, Math.floor(count / 3) + (index < count % 3 ? 1 : 0));
    }
    alternationInstalls = installs - before;
  } else if (values.burst) {
    const count = Number(values.burst);
    assert(Number.isSafeInteger(count) && count > 0 && count <= 100);
    const before = installs;
    await burst("burst", "fixture-initial", count);
    assert.equal(installs - before, 0, "Restart with unchanged template inputs must not reinstall");
  } else if (!values["seed-only"]) {
    await clone("source-change", "fixture-source-one");
  }
  if (values.contract) {
    const before = installs;
    await Promise.all([
      clone("waiter-a", "fixture-source-two"),
      clone("waiter-b", "fixture-source-two"),
    ]);
    assert.equal(installs - before, 1, "Concurrent callers must share one install");
    await clone("lock-change", "fixture-lock");
  }
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        backend: backend.id,
        files: payloadFiles,
        payloadBytes: payloadFiles * 17742,
        installs,
        alternationInstalls,
        rows,
        templates: await listTemplatesAsync(process.env),
      },
      null,
      2,
    ),
  );
  if (values.alternate) {
    assert.equal(alternationInstalls, 0, "Returning to three prepared commits must not reinstall");
  }
} finally {
  // Cleanup only this isolated database's builders; never enumerate global containers.
  for (const entry of (await readRegistry({ env: process.env })).entries) {
    await retireSandboxDependencyBuilder(entry, () => {}, true);
  }
  await closeOpenClawStateDatabaseAsync();
  await drainGlobalSingletonLifecycleState();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, instrumentation);
}
