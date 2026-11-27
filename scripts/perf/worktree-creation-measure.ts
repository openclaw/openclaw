import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { SandboxContext } from "../../src/agents/sandbox/types.js";
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
 * Main CPU/allocation exclude workers; process CPU includes workers, not Git children.
 * OPENCLAW_BENCH_BASELINE_DIR selects a sparse frozen owner overlay in every worker.
 * --eviction-delay-ms injects snapshot latency during capacity GC and measures a concurrent
 * creation once a slot is available. Records allocation wait plus whole-operation CPU.
 * --agent-db-fixture clones an offline synthetic agent database into each arm.
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
 * --refresh-commit alternates that commit and --expected-commit after an untimed
 * seed. On APFS it checks every tracked file's clone identity after each refresh.
 * --filesystem-owner loads a frozen filesystem-native.ts for receipt overhead A/B.
 * Native worker code is unchanged between arms; Linux procfs costs need Linux proof.
 * Acceptance: only changed-file bytes lose shared extents, clean old/new templates,
 * A/A controls and five serial A/B pairs; diagnostics must not add material cost.
 * --filesystem-worker selects the unchanged native filesystem worker from a frozen
 * repository compiler runtime, avoiding source-loader descendants in process settlement.
 * Add --first-send-image <local-podman-image> to include the real first-send preparation
 * owner after each create. The fixture needs an offline frozen dependency and a
 * postinstall copying advance.txt into node_modules/source-dependent.txt and its
 * ionice class into node_modules/install-priority.txt. Native
 * Podman and btrfs remain real; no model or Gateway transport is measured here.
 * --first-send-layout includes skill delivery, protected mount setup and container startup.
 * Compare its phase durations, CPU and allocation on the same fixture with two A/A
 * controls and five counterbalanced pairs. Require lower first-send latency, no
 * material CPU/allocation regression, identical source/dependency/skill contents,
 * and zero inline template builds. Parent and child durations are inclusive.
 * --expected-inline-builds 1 qualifies the baseline; the candidate requires zero.
 * Report idle/create/send work separately and total CPU/allocation with A/A controls.
 * --base-advance creates at A, pushes B to a local origin, runs the idle pass,
 * then measures first and warm creates at B. Run two A/A controls and five
 * interleaved A/B pairs with one sample per fresh synthetic clone. Acceptance:
 * first-create native copies 2 -> 1, correct B HEAD/contents, lower latency,
 * no >20% total idle+first+warm CPU/allocation regression beyond A/A variation.
 * --startup-refresh managed|sandbox sends at retained A while the idle pass builds C.
 * Inject one 30-second completion delay after a background native clone and fsync,
 * modeling delayed storage completion without claiming kernel metadata pressure.
 * Foreground IO is unchanged. Seed A/B first; retain real Git, native btrfs, Podman and
 * startup owners. Prepare a separate untimed session before measurement so the source
 * loader's compilation is not charged to the running Gateway's first send at a new tip.
 * The measured session still has no projection. Compare two A/A controls and five
 * serial A/B pairs per kind; report cold-source runs separately.
 * Acceptance: exact A HEAD/index/source/dependencies, zero inline builds, the send
 * completes during the storage delay, lower send latency without >20% total CPU or
 * allocation regression. refresh-overlap-total owns total resource accounting;
 * the nested send row includes concurrent work and must not be added to it.
 * --alternate-commit alternates source generations without requiring a refresh.
 * Acceptance: after seeding both commits, no new generation on a flip back;
 * report owner latency, CPU/allocation, and retained IDs with matched A/A controls.
 */
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    output: { type: "string" },
    samples: { type: "string", default: "5" },
    "default-base": { type: "boolean" },
    "base-advance": { type: "boolean" },
    "first-send-image": { type: "string" },
    "first-send-layout": { type: "boolean" },
    "startup-refresh": { type: "string" },
    "expected-inline-builds": { type: "string", default: "0" },
    "expected-commit": { type: "string" },
    "alternate-policy": { type: "boolean" },
    prewarm: { type: "boolean" },
    "checkout-owner": { type: "string" },
    fixture: { type: "boolean" },
    "project-routing": { type: "boolean" },
    "project-owner": { type: "string" },
    "eviction-delay-ms": { type: "string" },
    "agent-db-fixture": { type: "string" },
    "refresh-commit": { type: "string" },
    "alternate-commit": { type: "string" },
    "filesystem-owner": { type: "string" },
    "filesystem-worker": { type: "string" },
  },
});
assert(values.repo && values.output, "--repo and --output are required");
assert(
  !values["first-send-image"] || values["base-advance"],
  "--first-send-image requires --base-advance",
);
assert(
  !values["first-send-layout"] || values["first-send-image"],
  "--first-send-layout requires --first-send-image",
);
const startupRefresh = values["startup-refresh"];
assert(!startupRefresh || ["managed", "sandbox"].includes(startupRefresh));
assert(!startupRefresh || values["first-send-layout"]);
const output = path.resolve(values.output);
if (process.env.OPENCLAW_BENCH_BASELINE_DIR) {
  await import("./worker-retained-heap-preload.js");
}
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
let snapshotEntered: (() => void) | undefined;
let allocationWaitMs = 0;
const evictionDelayMs = Number(values["eviction-delay-ms"] ?? 0);
assert(Number.isFinite(evictionDelayMs) && evictionDelayMs >= 0);
const contentionKey = Symbol.for("openclaw.perf.worktree-contention");
Reflect.set(globalThis, contentionKey, {
  async snapshot() {
    if (snapshotEntered) {
      const entered = snapshotEntered;
      snapshotEntered = undefined;
      entered();
      await new Promise((resolve) => {
        setTimeout(resolve, evictionDelayMs);
      });
    }
  },
  phase(name?: string) {
    const start = performance.now();
    let finished = false;
    return () => {
      if (!finished && name === "allocationWait") {
        allocationWaitMs += performance.now() - start;
      }
      finished = true;
    };
  },
});
const hooks = registerHooks({
  load(url, context, next) {
    if (
      (values["filesystem-owner"] || values["filesystem-worker"]) &&
      url.endsWith("/src/agents/worktrees/filesystem-native.ts")
    ) {
      let source = readFileSync(values["filesystem-owner"] ?? new URL(url), "utf8");
      if (values["filesystem-worker"]) {
        const resolver = "return resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.fsSafeCopy);";
        assert(source.includes(resolver));
        source = source.replace(
          resolver,
          `return new URL(${JSON.stringify(values["filesystem-worker"])});`,
        );
      }
      return {
        format: "module-typescript",
        shortCircuit: true,
        source,
      };
    }
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
    if (evictionDelayMs && url.endsWith("/src/agents/worktrees/snapshot-host.ts")) {
      let source = readFileSync(new URL(url), "utf8");
      const declaration = "export async function captureManagedWorktreeSnapshot(";
      assert(source.includes(declaration));
      source = source.replace(declaration, "async function captureMeasuredSnapshot(");
      source += `\nexport async function captureManagedWorktreeSnapshot(...args: Parameters<typeof captureMeasuredSnapshot>) {
        await globalThis[Symbol.for("openclaw.perf.worktree-contention")].snapshot();
        return await captureMeasuredSnapshot(...args);
      }`;
      return { format: "module-typescript", shortCircuit: true, source };
    }
    if (evictionDelayMs && url.endsWith("/src/agents/worktrees/preparation-timing.ts")) {
      let source = readFileSync(new URL(url), "utf8");
      const declaration = "export function startWorktreePreparationPhase(";
      assert(source.includes(declaration));
      source = source.replace(declaration, "function startMeasuredPhase(");
      source += `\nexport function startWorktreePreparationPhase(...args: Parameters<typeof startMeasuredPhase>) {
        const finish = startMeasuredPhase(...args);
        const measure = globalThis[Symbol.for("openclaw.perf.worktree-contention")].phase(preparation.getStore() ? args[0] : undefined);
        return () => { measure(); finish(); };
      }`;
      return { format: "module-typescript", shortCircuit: true, source };
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
const config: OpenClawConfig = {
  ...(values["first-send-image"]
    ? {
        agents: {
          entries: { main: { workspace: repo } },
          defaults: {
            sandbox: {
              mode: "all",
              backend: "podman",
              docker: { image: values["first-send-image"], user: "0:0" },
            },
          },
        },
      }
    : {}),
  worktreeMaxCount: 4096,
  logging: {
    level: "info" as const,
    consoleLevel: "info" as const,
    file: path.join(output, "runtime.log"),
  },
};
setRuntimeConfigSnapshot(config, config);
if (values["agent-db-fixture"]) {
  const destination = path.join(
    process.env.OPENCLAW_STATE_DIR!,
    "agents/main/agent/openclaw-agent.sqlite",
  );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (process.platform === "darwin") {
    execFileSync("/bin/cp", ["-c", values["agent-db-fixture"], destination]);
  } else {
    await fs.copyFile(
      values["agent-db-fixture"],
      destination,
      fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL,
    );
  }
}
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { requireGit } = await import("../../src/agents/worktrees/git.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
if (values["default-base"]) {
  assert((await requireGit(repo, ["remote", "get-url", "origin"])).startsWith("file://"));
}
const commit = values["expected-commit"] ?? (await requireGit(repo, ["rev-parse", "HEAD"]));
const { listTemplatesAsync } =
  await import("../../src/agents/worktrees/template-registry-async.js");
const { nativeWorktreeFilesystem } =
  await import("../../src/agents/worktrees/filesystem-native.js");
const alternate = values["alternate-commit"] ?? values["refresh-commit"];
const refreshCommit = alternate
  ? await requireGit(repo, ["rev-parse", "--verify", `${alternate}^{commit}`])
  : undefined;
if (refreshCommit) {
  assert(
    values["alternate-commit"] || process.platform === "darwin",
    "Clone identity proof requires APFS",
  );
  assert(!values.prewarm && !values["alternate-policy"] && !values["default-base"]);
  await new ManagedWorktreeService({ getConfig: () => config }).create({
    repoRoot: repo,
    name: `seed-${path.basename(output)}`,
    baseRef: commit,
    ownerKind: "session",
    ownerId: "synthetic-seed",
    runSetupScript: false,
    provisionIgnoredFiles: false,
  });
}
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
      const project = await withProjectCheckoutLifecycle(repo, { context }, (lease) =>
        registerPreparedProjectRegistry(prepared, [lease], context),
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
const rows: unknown[] = [];
try {
  if (projectSelection) {
    // Fixture registration must not warm only the first measured state lookup.
    await drainGlobalSingletonLifecycleState();
  }
  if (values["base-advance"]) {
    const { prewarmLocalWorkspaceTemplates } =
      await import("../../src/gateway/worker-environments/local-workspace-prewarm.js");
    // Startup runs an empty idle pass before later creates; exclude lazy loader cost.
    await prewarmLocalWorkspaceTemplates({
      getConfig: () => config,
      signal: new AbortController().signal,
    });
    const service = new ManagedWorktreeService({ getConfig: () => config });
    const { replaceSessionEntry } = await import("../../src/config/sessions/session-accessor.js");
    const { prepareLocalSandboxWorkspace } =
      await import("../../src/agents/sandbox/local-workspace.js");
    const { resolveSandboxContext } = await import("../../src/agents/sandbox/context.js");
    const { resolveSandboxConfigForAgent } = await import("../../src/agents/sandbox/config.js");
    const { withWorktreePreparationTiming } =
      await import("../../src/agents/worktrees/preparation-timing.js");
    const { withDiagnosticsTimelineObserver } =
      await import("../../src/infra/diagnostics-timeline.js");
    const sandbox = resolveSandboxConfigForAgent(config, "main");
    const preparedLayouts: Array<{
      canonical: string;
      projection: string;
      skillsWorkspaceDir: string;
      eligibility: SandboxContext["skillsEligibility"];
      skillNames: string[];
    }> = [];
    const create = async (name: string) => {
      const sessionKey = `agent:main:prewarm-${name}`;
      const created = await service.create({
        repoRoot: repo,
        name,
        runSetupScript: false,
        provisionIgnoredFiles: false,
        ...(values["first-send-image"]
          ? { ownerKind: "session" as const, ownerId: sessionKey }
          : {}),
      });
      if (values["first-send-image"]) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          {
            sessionId: name,
            updatedAt: Date.now(),
            worktree: { id: created.id, branch: created.branch, repoRoot: created.repoRoot },
          },
        );
      }
      return { ...created, sessionKey };
    };
    const seed = await create("seed");
    const seedContents = startupRefresh
      ? await fs.readFile(path.join(seed.path, "advance.txt"), "utf8")
      : "";
    if (startupRefresh) {
      await prewarmLocalWorkspaceTemplates({
        getConfig: () => config,
        signal: new AbortController().signal,
      });
    }
    const loaderWarmup = startupRefresh ? await create("loader-warmup") : undefined;
    assert(
      (await listTemplatesAsync(process.env)).some(
        (entry) => entry.status === "ready" && entry.backend === "btrfs",
      ),
      "Base-advance proof requires a ready native btrfs template",
    );
    let contents = "synthetic base advance\n";
    await fs.writeFile(path.join(repo, "advance.txt"), contents);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 ** 2,
      }).trim();
    git("add", "advance.txt");
    git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "-qm",
      "advance",
    );
    git("push", "origin", "main");
    let target = git("rev-parse", "HEAD");
    // Let fetch freshness expire without skewing the host against lease workers.
    await delay(31_000);
    let clones = 0;
    let storageDelay: { entered: () => void; completed: boolean } | undefined;
    const copy = nativeWorktreeFilesystem.copy;
    nativeWorktreeFilesystem.copy = async (...args) => {
      clones++;
      await copy(...args);
      if (
        storageDelay &&
        args[2].idleIoPriority &&
        args[1].includes("/.templates/") &&
        args[1].includes("/worktree-projections/") === (startupRefresh === "sandbox")
      ) {
        const waiting = storageDelay;
        storageDelay = undefined;
        const directory = await fs.open(args[1], "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        waiting.entered();
        await delay(30_000);
        waiting.completed = true;
      }
    };
    const childCpu = () => {
      if (process.platform !== "linux") {
        return 0;
      }
      const fields = readFileSync("/proc/self/stat", "utf8").split(") ")[1]!.split(" ");
      return (Number(fields[13]) + Number(fields[14])) * 10;
    };
    // The isolated container cgroup also includes Podman builders after conmon reparents them.
    const containerCpu = () =>
      values["first-send-image"]
        ? Number(
            readFileSync("/sys/fs/cgroup/cpu.stat", "utf8").match(/^usage_usec (\d+)$/m)?.[1],
          ) / 1000
        : undefined;
    const measure = async <T>(phase: string, run: () => Promise<T>) => {
      gitTimings = {};
      workerTimings = {};
      const containerBefore = containerCpu();
      const monotonicStartUs = Number(process.hrtime.bigint() / 1000n);
      const cpu = process.cpuUsage();
      const mainCpu = process.threadCpuUsage();
      const allocated = getHeapStatistics().total_allocated_bytes;
      const children = childCpu();
      const beforeClones = clones;
      const start = performance.now();
      const phases: string[] = [];
      const phaseDurationsMs: Record<string, number> = {};
      const result = await withDiagnosticsTimelineObserver((name, _attributes, durationMs) => {
        phases.push(name);
        const phaseStart = performance.now();
        return () => {
          phaseDurationsMs[name] =
            (phaseDurationsMs[name] ?? 0) + (durationMs ?? performance.now() - phaseStart);
        };
      }, run);
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      const mainUsed = process.threadCpuUsage(mainCpu);
      const row = {
        phase,
        target,
        elapsedMs,
        monotonicStartUs,
        monotonicEndUs: Number(process.hrtime.bigint() / 1000n),
        containerCpuMs:
          containerBefore === undefined ? undefined : containerCpu()! - containerBefore,
        processCpuMs: (used.user + used.system) / 1000,
        mainThreadCpuMs: (mainUsed.user + mainUsed.system) / 1000,
        mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
        childCpuMs: childCpu() - children,
        nativeCopies: clones - beforeClones,
        templateBuilds: phases.filter(
          (name) =>
            name === "attempt.setup.sandbox.workspace_selection.prepare.reconcile.template.build",
        ).length,
        manifestCaptures: phases.filter((name) => name === "worktree.sandbox.snapshot").length,
        phaseDurationsMs,
        gitOperations: gitTimings,
        workerOperations: workerTimings,
        load: loadavg(),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      return { result, row };
    };
    const prepareSend = (created: { path: string; sessionKey: string }) =>
      withWorktreePreparationTiming("sandbox", async () => {
        if (values["first-send-layout"]) {
          const context = await resolveSandboxContext({
            config,
            agentId: "main",
            sessionKey: created.sessionKey,
            workspaceDir: created.path,
          });
          try {
            assert(context?.workspaceSource === "managed-worktree");
            assert(context.skillsWorkspaceDir);
            preparedLayouts.push({
              canonical: created.path,
              projection: context.workspaceDir,
              skillsWorkspaceDir: context.skillsWorkspaceDir,
              eligibility: context.skillsEligibility,
              skillNames: (context.skillUsagePaths ?? [])
                .map((skill) => skill.skillName)
                .toSorted(),
            });
            return context.workspaceDir;
          } finally {
            context?.[Symbol.dispose]?.();
          }
        }
        using prepared = await prepareLocalSandboxWorkspace({
          cfg: config,
          agentId: "main",
          sandbox,
          sessionKey: created.sessionKey,
          workspaceDir: created.path,
        });
        assert(prepared);
        return prepared.workspaceDir;
      });
    try {
      if (loaderWarmup) {
        await prepareSend(loaderWarmup);
        await delay(10);
      }
      await measure("idle", async () => {
        let observed = false;
        await prewarmLocalWorkspaceTemplates({
          getConfig: () => config,
          signal: new AbortController().signal,
          shouldDefer: startupRefresh
            ? async () => {
                if (!observed) {
                  observed = true;
                  const { resolveWorktreeBase } =
                    await import("../../src/agents/worktrees/base-ref.js");
                  await resolveWorktreeBase(repo);
                }
                return false;
              }
            : undefined,
        });
      });
      if (startupRefresh) {
        const { resolveWorktreeBase } = await import("../../src/agents/worktrees/base-ref.js");
        const { prepareSessionWorktree } =
          await import("../../src/gateway/session-worktree-preparation.js");
        const { resolveSessionStorePathCore } = await import("../../src/config/sessions/paths.js");
        await fs.writeFile(path.join(repo, "advance.txt"), "synthetic base C\n");
        git(
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.invalid",
          "commit",
          "-am",
          "advance again",
        );
        git("push", "origin", "main");
        // Model an already-observed advance, preserving the real fetch freshness window.
        await delay(31_000);
        const entered = Promise.withResolvers<void>();
        const delayed = { entered: () => entered.resolve(), completed: false };
        storageDelay = delayed;
        target = commit;
        contents = seedContents;
        let created = seed;
        await measure("refresh-overlap-total", async () => {
          let observed = false;
          const refresh = prewarmLocalWorkspaceTemplates({
            getConfig: () => config,
            signal: new AbortController().signal,
            shouldDefer: async () => {
              if (!observed) {
                observed = true;
                await resolveWorktreeBase(repo);
              }
              return false;
            },
          });
          await Promise.race([
            entered.promise,
            refresh.then(() => {
              throw new Error("Refresh finished before storage delay");
            }),
          ]);
          try {
            const { result: projection, row } = await measure(
              "first-send-during-refresh",
              async () => {
                if (startupRefresh === "managed") {
                  const sessionKey = "agent:main:retained-startup";
                  const prepared = await prepareSessionWorktree({
                    cfg: config,
                    target: {
                      agentId: "main",
                      key: sessionKey,
                      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
                    },
                    workspace: repo,
                    name: "retained-startup",
                    checkoutCommit: commit,
                    runSetupScript: false,
                  });
                  assert(prepared.ok, JSON.stringify(prepared));
                  assert(prepared.value.worktree && prepared.value.sessionRoot);
                  await replaceSessionEntry(
                    { agentId: "main", sessionKey },
                    {
                      sessionId: "retained-startup",
                      updatedAt: Date.now(),
                      worktree: prepared.value.worktree,
                    },
                  );
                  created = { ...seed, path: prepared.value.sessionRoot, sessionKey };
                }
                return await prepareSend(created);
              },
            );
            assert.equal(row.templateBuilds, 0);
            assert.equal(await requireGit(created.path, ["rev-parse", "HEAD"]), commit);
            assert.equal(await requireGit(projection, ["rev-parse", "HEAD"]), commit);
            assert.equal(await requireGit(projection, ["status", "--porcelain"]), "");
            assert.equal(
              await fs.readFile(path.join(projection, "advance.txt"), "utf8"),
              seedContents,
            );
            assert.equal(
              await fs.readFile(path.join(projection, "node_modules/source-dependent.txt"), "utf8"),
              seedContents,
            );
            console.log(
              JSON.stringify({
                startupRefresh,
                storageDelayMs: 30_000,
                storageStillPendingAtSendCompletion: !delayed.completed,
              }),
            );
          } finally {
            await refresh;
          }
        });
      }
      for (const name of startupRefresh ? [] : ["first", "warm"]) {
        const { result: created, row: creation } = await measure(name, () => create(name));
        assert(
          created &&
            typeof created === "object" &&
            "path" in created &&
            typeof created.path === "string",
        );
        assert.equal(git("rev-parse", "HEAD"), target);
        assert.equal(await requireGit(created.path, ["rev-parse", "HEAD"]), target);
        assert.equal(await fs.readFile(path.join(created.path, "advance.txt"), "utf8"), contents);
        assert.equal(await requireGit(created.path, ["status", "--porcelain"]), "");
        if (values["first-send-image"]) {
          assert.equal(creation.nativeCopies, 1, "Create must only clone its warm template");
          const { result: projection, row: measured } = await measure(`${name}-send`, () =>
            prepareSend(created),
          );
          assert.equal(await requireGit(projection, ["rev-parse", "HEAD"]), target);
          assert.equal(await requireGit(projection, ["status", "--porcelain"]), "");
          assert.equal(await fs.readFile(path.join(projection, "advance.txt"), "utf8"), contents);
          assert.equal(
            await fs.readFile(path.join(projection, "node_modules/source-dependent.txt"), "utf8"),
            contents,
          );
          assert.equal(
            (
              await fs.readFile(path.join(projection, "node_modules/install-priority.txt"), "utf8")
            ).trim() === "idle",
            Number(values["expected-inline-builds"]) === 0,
          );
          assert.equal(
            measured.templateBuilds,
            name === "first" ? Number(values["expected-inline-builds"]) : 0,
          );
          assert.equal(
            measured.manifestCaptures,
            name === "first" ? Number(values["expected-inline-builds"]) : 0,
          );
        }
      }
      await fs.writeFile(path.join(output, "results.json"), JSON.stringify(rows, null, 2));
      // Correctness checks run after all timed phases, so the fresh preparation
      // does not warm the measured second send or inflate its allocation counters.
      const verification = [];
      for (const [index, layout] of preparedLayouts.entries()) {
        const { captureWorkspaceManifestDocument } =
          await import("../../src/gateway/worker-environments/workspace-manifest-worker.js");
        const capture = (root: string) =>
          captureWorkspaceManifestDocument({
            root,
            baseCommit: target,
            buildCacheInputs: new Set<string>(),
          });
        const actual = await capture(layout.projection);
        assert.deepEqual(
          actual,
          await capture(layout.canonical),
          "Projection must match a fresh canonical capture",
        );
        const { syncWorkspaceSkills } =
          await import("../../src/skills/loading/workspace-skill-sync.runtime.js");
        const fresh = path.join(output, `fresh-skills-${index}`);
        const skills = await syncWorkspaceSkills({
          sourceWorkspaceDir: layout.projection,
          targetWorkspaceDir: fresh,
          config,
          agentId: "main",
          eligibility: layout.eligibility,
        });
        assert(layout.skillNames.length > 0, "The fixture must deliver skills");
        assert.deepEqual(skills.map((skill) => skill.skillName).toSorted(), layout.skillNames);
        async function inventory(root: string, relative = ""): Promise<string[]> {
          const entries: string[] = [];
          for (const name of (await fs.readdir(path.join(root, relative))).toSorted()) {
            if (!relative && name === ".openclaw-sync.json") {
              continue;
            }
            const child = path.join(relative, name);
            const absolute = path.join(root, child);
            const stat = await fs.lstat(absolute);
            entries.push(
              JSON.stringify([
                child,
                stat.mode,
                stat.isDirectory()
                  ? "directory"
                  : stat.isSymbolicLink()
                    ? await fs.readlink(absolute)
                    : createHash("sha256")
                        .update(await fs.readFile(absolute))
                        .digest("hex"),
              ]),
            );
            if (stat.isDirectory()) {
              entries.push(...(await inventory(root, child)));
            }
          }
          return entries;
        }
        const installed = await inventory(path.join(layout.skillsWorkspaceDir, "skills"));
        assert.deepEqual(
          installed,
          await inventory(path.join(fresh, "skills")),
          "Installed skills must equal a fresh prepare",
        );
        verification.push({
          projectionManifest: actual.manifestRef,
          skills: layout.skillNames,
          skillInventoryHash: createHash("sha256").update(JSON.stringify(installed)).digest("hex"),
        });
      }
      await fs.writeFile(
        path.join(output, "verification.json"),
        JSON.stringify(verification, null, 2),
      );
    } finally {
      nativeWorktreeFilesystem.copy = copy;
    }
  }
  for (let index = 0; index < (values["base-advance"] ? 0 : samples); index++) {
    const requestedCommit = refreshCommit && index % 2 === 0 ? refreshCommit : commit;
    const previous = refreshCommit
      ? (await listTemplatesAsync(process.env)).find((entry) => entry.status === "ready")
      : undefined;
    gitTimings = {};
    workerTimings = {};
    const service = new ManagedWorktreeService({ getConfig: () => config });
    let refill: Parameters<typeof service.prewarm>[0] | undefined;
    const unsubscribe = service.onWarmPoolNeeded((request) => {
      refill = request;
    });
    const sourceOnly = projectSelection ? false : !values["alternate-policy"] || index % 2 === 1;
    let collecting: ReturnType<typeof service.gc> | undefined;
    let maintenanceStart = 0;
    let maintenanceCpu = process.cpuUsage();
    let maintenanceAllocated = 0;
    if (evictionDelayMs) {
      await service.create({
        repoRoot: repo,
        name: `victim-${path.basename(output)}-${index}`,
        baseRef: commit,
        ownerKind: "manual",
        runSetupScript: false,
        provisionIgnoredFiles: false,
      });
      config.worktreeMaxCount = 0;
      const entered = new Promise<void>((resolve) => {
        snapshotEntered = resolve;
      });
      maintenanceStart = performance.now();
      maintenanceCpu = process.cpuUsage();
      maintenanceAllocated = getHeapStatistics().total_allocated_bytes;
      collecting = service.gc();
      await Promise.race([
        entered,
        collecting.then(() => {
          throw new Error("GC did not reach snapshot");
        }),
      ]);
      config.worktreeMaxCount = 4096;
    }
    allocationWaitMs = 0;
    const loadBefore = loadavg();
    const cpu = process.threadCpuUsage();
    const processCpu = process.cpuUsage();
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
            baseRef: values["default-base"] ? undefined : requestedCommit,
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
    const processUsed = process.cpuUsage(processCpu);
    const row = {
      index,
      requestedCommit,
      generations: values["alternate-commit"]
        ? (await listTemplatesAsync(process.env))
            .filter((entry) => entry.status === "ready")
            .map(({ id, sourceCommit, path: directory }) => ({ id, sourceCommit, directory }))
        : undefined,
      sourceOnly,
      ownerSha256,
      projectOwnerSha256,
      elapsedMs,
      allocationWaitMs,
      evictionDelayMs,
      maintenanceMs: 0,
      maintenanceProcessCpuMs: 0,
      maintenanceAllocatedBytes: 0,
      promptReadyMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      processCpuMs: (processUsed.user + processUsed.system) / 1000,
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
      sharedTrackedBytes: 0,
      nonsharedTrackedBytes: 0,
    };
    if (collecting) {
      const { acquireWorktreeRunLease } = await import("../../src/agents/worktrees/run-lease.js");
      assert("id" in created);
      const lease = await acquireWorktreeRunLease(created.id);
      try {
        await collecting;
        row.maintenanceMs = performance.now() - maintenanceStart;
        const maintenanceUsed = process.cpuUsage(maintenanceCpu);
        row.maintenanceProcessCpuMs = (maintenanceUsed.user + maintenanceUsed.system) / 1000;
        row.maintenanceAllocatedBytes =
          getHeapStatistics().total_allocated_bytes - maintenanceAllocated;
      } finally {
        await lease.release();
      }
    }
    assert.equal(await requireGit(created.path, ["rev-parse", "HEAD"]), requestedCommit);
    assert.equal(await requireGit(created.path, ["status", "--porcelain"]), "");
    if (refreshCommit && !values["alternate-commit"]) {
      assert(previous?.backend === "apfs");
      const current = (await listTemplatesAsync(process.env)).find(
        (entry) => entry.cacheKey === previous.cacheKey,
      );
      assert(current && current.id !== previous.id);
      assert.equal(current.sourceCommit, requestedCommit);
      const gitPaths = (args: string[]) =>
        execFileSync("git", ["-C", current.path, ...args], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        })
          .split("\0")
          .filter(Boolean);
      const changed = new Set(
        gitPaths([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          previous.sourceCommit,
          requestedCommit,
        ]),
      );
      const files = gitPaths(["ls-files", "-z"]);
      for (let offset = 0; offset < files.length; offset += 512) {
        const batch = files.slice(offset, offset + 512);
        const metadata = await nativeWorktreeFilesystem.readMetadata(
          batch.flatMap((name) => [path.join(previous.path, name), path.join(current.path, name)]),
          { commitGuard() {} },
        );
        for (const [i, name] of batch.entries()) {
          const old = metadata[2 * i];
          const fresh = metadata[2 * i + 1];
          assert(fresh?.type === 1, "Fixture must contain regular files");
          const shared = Boolean(old?.cloneId && old.cloneId === fresh.cloneId);
          assert.equal(shared, !changed.has(name), `Unexpected clone sharing: ${name}`);
          row[shared ? "sharedTrackedBytes" : "nonsharedTrackedBytes"] += Number(fresh.size);
        }
      }
      assert.equal(await requireGit(previous.path, ["rev-parse", "HEAD"]), previous.sourceCommit);
      assert.equal(await requireGit(previous.path, ["status", "--porcelain"]), "");
      assert.equal(await requireGit(current.path, ["status", "--porcelain"]), "");
    }
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
  Reflect.deleteProperty(globalThis, contentionKey);
}
