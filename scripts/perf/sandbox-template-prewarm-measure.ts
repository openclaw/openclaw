/**
 * Sandbox startup preparation after a lockfile advance.
 * Reuses lane 2416 synthetic seed/cleanup, with real clocks and the Linux spawn broker.
 * Run interleaved A/A and A/B arms; --baseline-dir freezes the three changed owners.
 * Every arm waits 120s after the advance, measuring all background CPU/allocation
 * and loop p99. See the PR for the pinned acceptance rule; no Team state is used.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { ManagedWorktreeRecord } from "../../src/agents/worktrees/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewaySchedulerClock } from "../../src/infra/gateway-scheduler.js";
import {
  morningSessionMaintenance,
  verifyMorningAgentSeed,
} from "./workspace-template-agent-seed.js";
import {
  cleanupMorningWorktrees,
  verifyMorningWorktreeCleanup,
} from "./workspace-template-morning-cleanup.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    image: { type: "string" },
    "state-dir": { type: "string" },
    "baseline-dir": { type: "string" },
  },
});
assert.equal(process.platform, "linux", "This workload qualifies native Linux/Btrfs preparation");
const clockTicks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
async function vmActiveCpuMs() {
  const counters = (await fs.readFile("/proc/stat", "utf8"))
    .split("\n")[0]!
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  // User/nice include guest time already. Exclude idle and I/O wait; include the
  // broker, Git, Docker daemon, containers and all other work in this isolated VM.
  return ([0, 1, 2, 5, 6, 7].reduce((sum, index) => sum + counters[index]!, 0) * 1000) / clockTicks;
}
assert(values.fixture && values.output && values.image, "--fixture, --output and --image required");
assert(
  values["state-dir"],
  "--state-dir must be the campaign's original writable synthetic agent state",
);
const output = path.resolve(values.output);
await fs.mkdir(output);
const repo = path.join(output, "source");
const origin = path.join(output, "origin.git");
const command = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith("GIT_")) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: path.resolve(values["state-dir"]),
  OPENCLAW_HOME: output,
  TMPDIR: path.join(output, "tmp"),
  XDG_CONFIG_HOME: path.join(output, "config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
await fs.mkdir(process.env.TMPDIR!, { recursive: true });
const agentSeedBefore = verifyMorningAgentSeed(process.env.OPENCLAW_STATE_DIR!);
assert(
  agentSeedBefore.fullScale,
  "Morning replay requires the allocated 35 GiB / 10k-session seed",
);
const { readSqliteCleanCloseSeal } = await import("../../src/infra/sqlite-clean-close-seal.js");
const sealBefore = readSqliteCleanCloseSeal(
  agentSeedBefore.databasePath,
  await fs.stat(agentSeedBefore.databasePath, { bigint: true }),
);
assert(sealBefore, "Warm morning replay requires the preceding owner's genuine clean-close seal");
// Borrow only immutable synthetic objects. Every ref and checkout below is task-owned.
command(output, "clone", "--quiet", "--bare", path.resolve(values.fixture), origin);
command(origin, "update-ref", "refs/heads/main", "refs/tags/fixture-base");
command(origin, "symbolic-ref", "HEAD", "refs/heads/main");
command(output, "clone", "--quiet", "--no-hardlinks", origin, repo);
command(repo, "config", "user.name", "Synthetic Fixture");
command(repo, "config", "user.email", "fixture@example.invalid");
command(repo, "config", "gc.auto", "0");
const commits = [command(repo, "rev-parse", "HEAD")];
for (let index = 1; index <= 1; index++) {
  await fs.writeFile(path.join(repo, "source.txt"), `morning-${index}\n`);
  await fs.writeFile(
    path.join(repo, "vendor/dependency/index.js"),
    `module.exports = 'morning-${index}';\n`,
  );
  await fs.appendFile(path.join(repo, "pnpm-lock.yaml"), "\n# changed dependency generation\n");
  command(repo, "commit", "-qam", `synthetic main advance ${index}`);
  commits.push(command(repo, "rev-parse", "HEAD"));
}
command(repo, "push", "--quiet", "origin", "main:refs/heads/fixture-series");
command(repo, "checkout", "--quiet", "--detach", commits[0]!);
const shape = command(repo, "ls-tree", "-r", "--format=%(objectsize)", commits[0]!, "--", "src")
  .split("\n")
  .map(Number);
assert.equal(shape.length, 62_000, "Use the existing full-sized synthetic fixture");
assert.equal(
  shape.reduce((bytes, size) => bytes + size, 0),
  1_100_004_000,
);

const frozenOwners = new Set([
  "server-startup-handler-prewarm.ts",
  "local-workspace-prewarm.ts",
  "local-workspace-template.ts",
]);
const instrumentation = Symbol.for("openclaw.perf.sandbox-template-prewarm");
let installs = 0;
Object.defineProperty(globalThis, instrumentation, { configurable: true, value: () => installs++ });
const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith("/src/agents/sandbox/dependency-template.ts")) {
      const original = readFileSync(new URL(url), "utf8");
      const source = original.replace(
        "export async function prepareSandboxDependencyTemplate(",
        "async function measuredPrepareSandboxDependencyTemplate(",
      );
      assert.notEqual(source, original, "Installer instrumentation must bind the real owner");
      return {
        format: "module-typescript",
        shortCircuit: true,
        source:
          source +
          `\nexport async function prepareSandboxDependencyTemplate(...args: Parameters<typeof measuredPrepareSandboxDependencyTemplate>) { globalThis[Symbol.for("openclaw.perf.sandbox-template-prewarm")](); return await measuredPrepareSandboxDependencyTemplate(...args); }\n`,
      };
    }
    const name = path.basename(url);
    if (values["baseline-dir"] && frozenOwners.has(name) && url.includes("/src/gateway/")) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: readFileSync(path.join(values["baseline-dir"], name), "utf8"),
      };
    }
    return next(url, context);
  },
});
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const config: OpenClawConfig = {
  session: { maintenance: morningSessionMaintenance },
  worktreeRoot: path.join(output, "managed"),
  agents: {
    defaults: {
      workspace: repo,
      sandbox: {
        mode: "all",
        backend: "docker",
        docker: { image: values.image, network: "none" },
      },
    },
  },
  logging: { level: "info", consoleLevel: "warn", file: path.join(output, "runtime.log") },
};
setRuntimeConfigSnapshot(config, config);
const { resolveSandboxConfigForAgent } = await import("../../src/agents/sandbox/config.js");
const { ManagedWorktreeService } = await import("../../src/agents/worktrees/service.js");
const { resolveWorktreeBase } = await import("../../src/agents/worktrees/base-ref.js");
const { prepareLocalSandboxWorkspace } =
  await import("../../src/agents/sandbox/local-workspace.js");
const { replaceSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry.js");
const { withWorktreePreparationTiming } =
  await import("../../src/agents/worktrees/preparation-timing.js");
const { withDiagnosticsTimelineObserver } = await import("../../src/infra/diagnostics-timeline.js");
const { onTrustedInternalDiagnosticEvent, setDiagnosticsEnabledForProcess } =
  await import("../../src/infra/diagnostic-events.js");
const { listTemplatesAsync } =
  await import("../../src/agents/worktrees/template-registry-async.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { readSqliteDatabaseIntegrityVerification } =
  await import("../../src/infra/sqlite-database-admission.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { nativeWorktreeFilesystem } =
  await import("../../src/agents/worktrees/filesystem-native.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const { createSpawnBrokerHost } = await import("../../src/process/spawn-broker/host.js");
const { runWithSpawnBroker } = await import("../../src/process/spawn-broker/context.js");
const { runWithGatewayIndependentRootWorkAdmission } =
  await import("../../src/process/gateway-work-admission.js");
const broker = process.platform === "linux" ? createSpawnBrokerHost() : undefined;
await broker?.ready();
const runCampaign = async () => {
  const service = new ManagedWorktreeService({ getConfig: () => config });
  const sandbox = resolveSandboxConfigForAgent(config, "fixture");
  const signal = new AbortController().signal;
  const clockOrigin = performance.now();
  const clockNow = () => performance.now() - clockOrigin;
  const running = new Set<Promise<void>>();
  const errors: string[] = [];
  const clock: GatewaySchedulerClock = {
    now: clockNow,
    monotonicNow: clockNow,
    arm(run, delayMs) {
      const timer = setTimeout(() => {
        const pending = Promise.resolve()
          .then(run)
          .catch((error: unknown) => {
            errors.push(String(error));
          })
          .finally(() => running.delete(pending));
        running.add(pending);
      }, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
  const scheduler = new GatewayScheduler({ clock });
  const advance = async (at: number) => {
    await delay(Math.max(0, at - clockNow()));
  };
  const { scheduleGatewayPrewarm } =
    await import("../../src/gateway/server-startup-handler-prewarm.js");
  const prewarm = scheduleGatewayPrewarm({
    scheduler,
    getConfig: () => config,
    log: { warn: (message) => errors.push(message) },
  });
  const resources = () => ({
    process: process.cpuUsage(),
    thread: process.threadCpuUsage(),
    allocated: getHeapStatistics().total_allocated_bytes,
  });
  assert(Number.isFinite(resources().allocated), "Node must expose exact V8 allocation counters");
  const used = (before: ReturnType<typeof resources>) => ({
    processCpuMs: Object.values(process.cpuUsage(before.process)).reduce((a, b) => a + b) / 1000,
    mainThreadCpuMs:
      Object.values(process.threadCpuUsage(before.thread)).reduce((a, b) => a + b) / 1000,
    mainThreadAllocatedBytes: getHeapStatistics().total_allocated_bytes - before.allocated,
  });
  const rows: object[] = [];
  const events: object[] = [];
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "diagnostic.phase.completed" && event.name === "worktree.preparation") {
      events.push({ logicalAt: clockNow(), ...event });
    }
  });
  const campaignStart = performance.now();
  const worktrees: ManagedWorktreeRecord[] = [];
  const sessions: Array<{ sessionKey: string; sessionId: string }> = [];
  async function request(label: string, commit: string, guest = true, discover = false) {
    const sessionKey = `agent:fixture:morning-${path.basename(output)}-${label}`;
    const phases: Record<string, number> = {};
    const before = resources();
    const beforeInstalls = installs;
    const started = performance.now();
    const logicalAt = clockNow();
    const backgroundActiveAtArrival = running.size > 0;
    let destination = "";
    await runWithGatewayIndependentRootWorkAdmission(
      () =>
        withDiagnosticsTimelineObserver(
          (name, _attributes, duration) => {
            if (duration !== undefined) {
              phases[name] = (phases[name] ?? 0) + duration;
              return undefined;
            }
            const at = performance.now();
            return () => {
              phases[name] = (phases[name] ?? 0) + performance.now() - at;
            };
          },
          async () => {
            const worktree = await service.create({
              repoRoot: repo,
              ...(discover ? {} : { baseRef: commit, checkoutCommit: commit }),
              ownerKind: "session",
              ownerId: sessionKey,
              name: label,
              runSetupScript: false,
              provisionIgnoredFiles: false,
            });
            worktrees.push(worktree);
            destination = worktree.path;
            if (guest) {
              const { id, branch, repoRoot } = worktree;
              const sessionId = randomUUID();
              sessions.push({ sessionKey, sessionId });
              await replaceSessionEntry(
                { agentId: "fixture", sessionKey },
                { sessionId, updatedAt: Date.now(), worktree: { id, branch, repoRoot } },
              );
              destination = await withWorktreePreparationTiming("sandbox", async () => {
                using projection = await prepareLocalSandboxWorkspace({
                  cfg: config,
                  agentId: "fixture",
                  sessionKey,
                  workspaceDir: worktree.path,
                  sandbox,
                  signal,
                });
                assert(projection, "Synthetic session must resolve its managed workspace owner");
                return projection.workspaceDir;
              });
            }
          },
        ),
      "perf:startup",
      signal,
    );
    rows.push({
      label,
      commit,
      guest,
      discover,
      logicalAt,
      backgroundActiveAtArrival,
      actualAtMs: started - campaignStart,
      elapsedMs: performance.now() - started,
      ...used(before),
      installs: installs - beforeInstalls,
      phases,
      load: loadavg(),
    });
    assert.equal(command(destination, "rev-parse", "HEAD"), commit);
    assert.equal(command(destination, "status", "--porcelain"), "");
    const source = await fs.readFile(path.join(destination, "source.txt"), "utf8");
    assert.equal(source, `${command(repo, "show", `${commit}:source.txt`)}\n`);
    if (guest) {
      assert.equal(
        await fs.readFile(path.join(destination, "node_modules/source-derived.txt"), "utf8"),
        source,
      );
      assert.equal(
        await fs.readFile(
          path.join(destination, "node_modules/fixture-dependency/index.js"),
          "utf8",
        ),
        `${command(repo, "show", `${commit}:vendor/dependency/index.js`)}\n`,
      );
    }
    console.log(
      JSON.stringify({ completed: label, actualAtMs: performance.now() - campaignStart }),
    );
  }
  let replayOrigin = 0;
  let admittedVerificationAt: number | undefined;
  let templates: Awaited<ReturnType<typeof listTemplatesAsync>> | undefined;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  try {
    await request("seed", commits[0]!);
    admittedVerificationAt = readSqliteDatabaseIntegrityVerification(
      agentSeedBefore.databasePath,
    )?.verifiedAt;
    assert.equal(
      admittedVerificationAt,
      sealBefore.verifiedAt,
      "Normal agent admission must reuse the genuine prior verification",
    );
    await resolveWorktreeBase(repo);
    await delay(0);
    events.length = 0;
    replayOrigin = clockNow();
    const before = resources();
    const started = performance.now();
    const beforeInstalls = installs;
    const vmCpuBefore = await vmActiveCpuMs();
    command(origin, "update-ref", "refs/heads/main", commits[1]!);
    loop.enable();
    await advance(replayOrigin + 120_000);
    rows.push({ label: "arrival", backgroundInstalls: installs - beforeInstalls });
    await request("first-after-lockfile-advance", commits[1]!, true, true);
    loop.disable();
    rows.push({
      label: "campaign",
      elapsedMs: performance.now() - started,
      ...used(before),
      installs: installs - beforeInstalls,
      vmActiveCpuMs: (await vmActiveCpuMs()) - vmCpuBefore,
      vmCpuScope:
        "All VM active CPU, including installer/broker/Git and unrelated guest work; interleaved controls qualify noise",
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      eventLoopMaxMs: loop.max / 1e6,
    });
    // Inspect retention before stop can cancel pending maintenance.
    templates = await listTemplatesAsync(process.env);
  } finally {
    await Promise.all(prewarm.map((handle) => Promise.resolve(handle.stop())));
    await scheduler.stop();
    unsubscribe();
    try {
      await fs.writeFile(
        path.join(output, "results.json"),
        JSON.stringify(
          {
            sourceHead: command(process.cwd(), "rev-parse", "HEAD"),
            prewarm: !values["baseline-dir"],
            timingMode: "real-clock",
            node: process.version,
            replayOrigin,
            files: shape.length,
            payloadBytes: 1_100_004_000,
            agentSeedBefore,
            admission: {
              priorVerificationAt: sealBefore.verifiedAt,
              admittedVerificationAt,
              reused: admittedVerificationAt === sealBefore.verifiedAt,
            },
            sessionMaintenance: morningSessionMaintenance,
            commits,
            rows,
            events,
            errors,
            templateSnapshotWhileLive: templates !== undefined,
            templates: templates ?? (await listTemplatesAsync(process.env)),
          },
          null,
          2,
        ),
      );
      const cleanup = await cleanupMorningWorktrees({ service, worktrees, sessions });
      await fs.writeFile(
        path.join(output, "cleanup.json"),
        JSON.stringify(cleanup, null, 2) + "\n",
      );
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      await drainGlobalSingletonLifecycleState();
    }
    const cleanupAfter = await verifyMorningWorktreeCleanup(process.env.OPENCLAW_STATE_DIR!);
    await fs.writeFile(
      path.join(output, "cleanup-after.json"),
      JSON.stringify(cleanupAfter, null, 2) + "\n",
    );
    const agentSeedAfter = verifyMorningAgentSeed(
      process.env.OPENCLAW_STATE_DIR!,
      agentSeedBefore.sessions - agentSeedBefore.seededSessions + sessions.length,
    );
    assert(
      readSqliteCleanCloseSeal(
        agentSeedAfter.databasePath,
        await fs.stat(agentSeedAfter.databasePath, { bigint: true }),
      ),
      "Normal owner close must publish a valid seal for the next arm",
    );
    await fs.writeFile(
      path.join(output, "agent-state-after.json"),
      JSON.stringify({ ...agentSeedAfter, cleanCloseSeal: true }, null, 2) + "\n",
    );
    for (const directory of ["managed", "state", "source", "origin.git", "tmp", "config"]) {
      const target = path.join(output, directory);
      if (
        await fs.stat(target).then(
          () => true,
          () => false,
        )
      ) {
        await nativeWorktreeFilesystem.remove(target, { commitGuard: () => {} });
      }
    }
  }
  assert.deepEqual(errors, [], "Background prewarm errors must be investigated");
};
try {
  if (broker) {
    await runWithSpawnBroker(broker, runCampaign);
  } else {
    await runCampaign();
  }
} finally {
  await broker?.close();
  hooks.deregister();
  Reflect.deleteProperty(globalThis, instrumentation);
}
