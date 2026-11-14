/**
 * node --import ./scripts/tsx.mjs scripts/perf/worktree-creation-measure.ts \
 *   --repo <task-owned-clone> --output <new-directory> --samples 5
 * Run serial AB/BA arms from the respective source revisions, ten creations per
 * revision. The repository must be a disposable local clone; refs and worktrees
 * are created only there and below output. --default-base includes remote refresh
 * and base hydration against the fixture's file:// origin. No hooks or setup code.
 * Each creation uses the real service, state leases, Git workers and native Git.
 * Workers drain between samples to model infrequent fresh-session creation.
 * Source-loader startup precedes timing; worker startup is included. Owner logs
 * report inclusive preparation phases; Git and worker timings are also inclusive.
 * CPU/allocation cover the main JS thread, excluding workers and Git children.
 * Acceptance: same checkout commit/files, one fewer cold object census, lower
 * owner CPU/allocation, no material creation regression with matched controls.
 * Small samples describe latency, never establish p99. This is not Gateway load.
 * --alternate-policy alternates ordinary/source-only requests at one commit.
 * --prewarm drains the service's refill request between creates; its cost is
 * reported separately. --checkout-owner loads a frozen baseline checkout.ts.
 * Policy acceptance: two cold builds then warm reuse, identical clean contents,
 * lower preparation cost without >20% CPU/allocation or same-mode regression.
 * --project-routing measures cloned-project source selection plus allocation,
 * with omitted worktree intent. --project-owner loads a frozen baseline
 * session-create-project.ts. Scratch writes run after timing and report their
 * placement; session-row admission and model execution are not measured.
 * Routing acceptance: identical source commit, zero base-clone scratch bytes.
 * Report the added checkout cost; this correctness change is not a speedup.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync, statSync } from "node:fs";
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
    "default-base": { type: "boolean" },
    "expected-commit": { type: "string" },
    "alternate-policy": { type: "boolean" },
    prewarm: { type: "boolean" },
    "checkout-owner": { type: "string" },
    fixture: { type: "boolean" },
    "project-routing": { type: "boolean" },
    "project-owner": { type: "string" },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
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
if (values.fixture) {
  // 50k tracked source files + 12k ignored dependency files, 1.10 GB in total.
  // Managed source templates must never copy the host's node_modules.
  await fs.mkdir(values.repo);
  const payload = Buffer.alloc(17742, 120);
  for (let index = 0; index < 62000; index++) {
    const directory = path.join(
      values.repo,
      index < 50000 ? "src" : "node_modules/.pnpm/fixture/node_modules/dependency",
      `group-${Math.floor(index / 100)}`,
    );
    if (index % 100 === 0) {
      await fs.mkdir(directory, { recursive: true });
    }
    await fs.writeFile(path.join(directory, `file-${index}.txt`), payload);
  }
  await fs.writeFile(path.join(values.repo, ".gitignore"), "node_modules/\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", values.repo!, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "synthetic",
  );
}
const repo = await fs.realpath(values.repo);
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
    if (
      values["project-owner"] &&
      url.endsWith("/src/gateway/server-methods/session-create-project.ts")
    ) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: readFileSync(values["project-owner"], "utf8"),
      };
    }
    if (values["checkout-owner"] && url.endsWith("/src/agents/worktrees/checkout.ts")) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: readFileSync(values["checkout-owner"], "utf8"),
      };
    }
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
if (values["default-base"]) {
  assert((await requireGit(repo, ["remote", "get-url", "origin"])).startsWith("file://"));
}
const commit = values["expected-commit"] ?? (await requireGit(repo, ["rev-parse", "HEAD"]));
const projectSelection = values["project-routing"]
  ? await (async () => {
      const { prepareProjectRegistration, registerPreparedProjectRegistry } =
        await import("../../src/projects/project-registration.js");
      const { withProjectCheckoutLifecycle } =
        await import("../../src/projects/project-checkout.js");
      const { captureOpenClawStateWorkerContext } =
        await import("../../src/state/openclaw-state-worker-context.js");
      const context = captureOpenClawStateWorkerContext({ env: process.env });
      const prepared = await prepareProjectRegistration({
        path: repo,
        source: "cloned",
        name: "Synthetic clone",
      });
      const project = await withProjectCheckoutLifecycle(repo, { env: process.env }, (lease) =>
        registerPreparedProjectRegistry(prepared, lease, context),
      );
      const owner = await import("../../src/gateway/server-methods/session-create-project.js");
      // The baseline exposes only a root; the candidate also owns placement intent.
      const candidate = Reflect.get(owner, "resolveRequestedSessionProject");
      const resolve = candidate ?? Reflect.get(owner, "resolveRequestedSessionProjectRoot");
      assert.equal(typeof resolve, "function");
      return async (): Promise<{ root: string; worktree: boolean }> => {
        const result: { ok: true; value: unknown } | { ok: false; error: unknown } = await resolve(
          config,
          { projectId: project.id },
          null,
        );
        assert(result.ok, JSON.stringify(result.ok ? undefined : result.error));
        if (typeof result.value === "string") {
          return { root: result.value, worktree: false };
        }
        assert(result.value && typeof result.value === "object");
        assert("root" in result.value && typeof result.value.root === "string");
        assert("worktree" in result.value && typeof result.value.worktree === "boolean");
        return { root: result.value.root, worktree: result.value.worktree };
      };
    })()
  : undefined;
const ownerSha256 = createHash("sha256")
  .update(
    await fs.readFile(
      values["checkout-owner"] ??
        new URL("../../src/agents/worktrees/checkout.ts", import.meta.url),
    ),
  )
  .digest("hex");
const projectOwnerSha256 = projectSelection
  ? createHash("sha256")
      .update(
        await fs.readFile(
          values["project-owner"] ??
            new URL("../../src/gateway/server-methods/session-create-project.ts", import.meta.url),
        ),
      )
      .digest("hex")
  : undefined;
const rows = [];
try {
  if (projectSelection) {
    // Fixture registration must not warm only the first measured state lookup.
    await drainGlobalSingletonLifecycleState();
  }
  for (let index = 0; index < samples; index++) {
    gitTimings = {};
    workerTimings = {};
    const service = new ManagedWorktreeService({ getConfig: () => config });
    let refill: Parameters<typeof service.prewarm>[0] | undefined;
    const unsubscribe = service.onWarmPoolNeeded((request) => {
      refill = request;
    });
    const sourceOnly = projectSelection ? false : !values["alternate-policy"] || index % 2 === 1;
    const loadBefore = loadavg();
    const cpu = process.threadCpuUsage();
    const allocated = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocated), "Runtime must expose exact V8 allocation counters");
    const start = performance.now();
    let promptReadyMs: number | undefined;
    const selected = projectSelection ? await projectSelection() : undefined;
    const created =
      selected && !selected.worktree
        ? { path: selected.root }
        : await service.create({
            repoRoot: selected?.root ?? repo,
            name: `measure-${path.basename(output)}-${index}`,
            baseRef: values["default-base"] ? undefined : commit,
            ownerKind: "session",
            ownerId: `synthetic-${index}`,
            runSetupScript: false,
            provisionIgnoredFiles: !sourceOnly,
            onPromptReady: projectSelection
              ? undefined
              : async () => {
                  promptReadyMs = performance.now() - start;
                },
          });
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    const row = {
      index,
      sourceOnly,
      ownerSha256,
      projectOwnerSha256,
      elapsedMs,
      promptReadyMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
      gitTimings: structuredClone(gitTimings),
      workerTimings: structuredClone(workerTimings),
      loadBefore,
      loadAfter: loadavg(),
      memory: process.memoryUsage(),
      refillMs: 0,
      refillMainCpuMs: 0,
      refillMainAllocatedBytes: 0,
      baseScratchBytes: 0,
      managedScratchBytes: 0,
    };
    assert.equal(await requireGit(created.path, ["rev-parse", "HEAD"]), commit);
    assert.equal(await requireGit(created.path, ["status", "--porcelain"]), "");
    if (projectSelection) {
      const scratch = path.join(created.path, ".openclaw/tmp/placement-measure");
      await fs.mkdir(scratch, { recursive: true });
      const bytes = 16 * 1024 * 1024;
      const file = path.join(scratch, "synthetic-build.bin");
      await fs.writeFile(file, Buffer.alloc(bytes, 0x61));
      row.baseScratchBytes =
        statSync(path.join(repo, ".openclaw/tmp/placement-measure/synthetic-build.bin"), {
          throwIfNoEntry: false,
        })?.size ?? 0;
      row.managedScratchBytes = created.path === repo ? 0 : statSync(file).size;
      assert.equal(row.baseScratchBytes + row.managedScratchBytes, bytes);
      await fs.rm(scratch, { recursive: true });
      await fs.rmdir(path.dirname(scratch));
      await fs.rmdir(path.dirname(path.dirname(scratch)));
    }
    if (values["alternate-policy"]) {
      assert.equal(
        await fs.stat(path.join(created.path, "node_modules")).catch(() => undefined),
        undefined,
      );
    }
    unsubscribe();
    if (values.prewarm && refill) {
      const refillStart = performance.now();
      const refillCpu = process.threadCpuUsage();
      const refillAllocated = getHeapStatistics().total_allocated_bytes;
      await service.prewarm(refill, { commitGuard: () => {} });
      row.refillMs = performance.now() - refillStart;
      const refillUsed = process.threadCpuUsage(refillCpu);
      row.refillMainCpuMs = (refillUsed.user + refillUsed.system) / 1000;
      row.refillMainAllocatedBytes = getHeapStatistics().total_allocated_bytes - refillAllocated;
    }
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
