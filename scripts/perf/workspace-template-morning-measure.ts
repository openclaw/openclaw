/**
 * Real managed/private template owners under seven first-parent main advances.
 * See workspace-template-morning-measure.md for timing and acceptance boundaries.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { GatewaySchedulerClock } from "../../src/infra/gateway-scheduler.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    output: { type: "string" },
    image: { type: "string" },
    prewarm: { type: "boolean" },
  },
});
assert(values.fixture && values.output && values.image, "--fixture, --output and --image required");
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
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  OPENCLAW_HOME: output,
  TMPDIR: path.join(output, "tmp"),
  XDG_CONFIG_HOME: path.join(output, "config"),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});
await fs.mkdir(process.env.TMPDIR!, { recursive: true });
// Borrow only immutable synthetic objects. Every ref and checkout below is task-owned.
command(output, "clone", "--quiet", "--bare", path.resolve(values.fixture), origin);
command(origin, "update-ref", "refs/heads/main", "refs/tags/fixture-base");
command(origin, "symbolic-ref", "HEAD", "refs/heads/main");
command(output, "clone", "--quiet", "--no-hardlinks", origin, repo);
command(repo, "config", "user.name", "Synthetic Fixture");
command(repo, "config", "user.email", "fixture@example.invalid");
command(repo, "config", "gc.auto", "0");
const commits = [command(repo, "rev-parse", "HEAD")];
for (let index = 1; index <= 7; index++) {
  await fs.writeFile(path.join(repo, "source.txt"), `morning-${index}\n`);
  await fs.writeFile(
    path.join(repo, "vendor/dependency/index.js"),
    `module.exports = 'morning-${index}';\n`,
  );
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

const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const config: OpenClawConfig = {
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
const { readRegistry } = await import("../../src/agents/sandbox/registry.js");
const { retireSandboxDependencyBuilder } =
  await import("../../src/agents/sandbox/dependency-template.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { nativeWorktreeFilesystem } =
  await import("../../src/agents/worktrees/filesystem-native.js");
const { GatewayScheduler } = await import("../../src/infra/gateway-scheduler.js");
const service = new ManagedWorktreeService({ getConfig: () => config });
const sandbox = resolveSandboxConfigForAgent(config, "fixture");
const signal = new AbortController().signal;
const clockOrigin = performance.now();
let idleOffset = 0;
const clockNow = () => idleOffset + performance.now() - clockOrigin;
let armed: { at: number; run: () => void | Promise<void>; rearm: () => void } | undefined;
const running = new Set<Promise<void>>();
const errors: string[] = [];
const clock: GatewaySchedulerClock = {
  now: clockNow,
  monotonicNow: clockNow,
  arm(run, delayMs) {
    let active = true;
    let nativeTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = {
      at: clockNow() + delayMs,
      rearm: () => {
        clearTimeout(nativeTimer);
        nativeTimer = setTimeout(() => void timer.run(), Math.max(0, timer.at - clockNow()));
        nativeTimer.unref();
      },
      run: () => {
        if (!active) {
          return undefined;
        }
        active = false;
        clearTimeout(nativeTimer);
        if (armed === timer) {
          armed = undefined;
        }
        const pending = Promise.resolve()
          .then(run)
          .catch((error: unknown) => {
            errors.push(String(error));
          })
          .finally(() => running.delete(pending));
        running.add(pending);
        return pending;
      },
    };
    armed = timer;
    timer.rearm();
    return () => {
      active = false;
      clearTimeout(nativeTimer);
      if (armed === timer) {
        armed = undefined;
      }
    };
  },
};
const scheduler = new GatewayScheduler({ clock });
const advance = async (at: number) => {
  // Only idle gaps jump. A user deadline can arrive while native prewarm is still running.
  while (clockNow() < at) {
    if (running.size) {
      const deadline = new AbortController();
      try {
        await Promise.race([
          Promise.all(running),
          delay(Math.max(0, at - clockNow()), undefined, { signal: deadline.signal }),
        ]);
      } finally {
        deadline.abort();
      }
    } else {
      idleOffset += Math.max(0, Math.min(at, armed?.at ?? at) - clockNow());
      if (armed && armed.at <= clockNow()) {
        void armed.run();
      } else {
        armed?.rearm();
      }
    }
  }
};
const prewarm = values.prewarm
  ? (await import("../../src/gateway/workspace-template-prewarm.js")).startWorkspaceTemplatePrewarm(
      {
        scheduler: scheduler.scope(),
        getConfig: () => config,
        onError: (message) => errors.push(message),
      },
    )
  : undefined;
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
async function request(label: string, commit: string, guest = true, discover = false) {
  const sessionKey = `agent:fixture:${label}`;
  const phases: Record<string, number> = {};
  const before = resources();
  const started = performance.now();
  const logicalAt = clockNow();
  const backgroundActiveAtArrival = running.size > 0;
  let destination = "";
  await withDiagnosticsTimelineObserver(
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
      destination = worktree.path;
      if (guest) {
        const { id, branch, repoRoot } = worktree;
        await replaceSessionEntry(
          { agentId: "fixture", sessionKey },
          { sessionId: randomUUID(), updatedAt: Date.now(), worktree: { id, branch, repoRoot } },
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
      await fs.readFile(path.join(destination, "node_modules/fixture-dependency/index.js"), "utf8"),
      `${command(repo, "show", `${commit}:vendor/dependency/index.js`)}\n`,
    );
  }
  console.log(JSON.stringify({ completed: label, actualAtMs: performance.now() - campaignStart }));
}
let lastRefreshAt = -Infinity;
async function observe(index: number) {
  // Leave the owner's real freshness contract intact; compress only remaining idle time.
  await delay(Math.max(0, 30_100 - (Date.now() - lastRefreshAt)));
  if (index === 0) {
    const base = await resolveWorktreeBase(repo);
    assert.equal(base.commit, commits[index]);
    assert.equal(base.fetchSucceeded, true);
  } else {
    // Default-base refresh is demand-driven. Charge its first template miss to this user.
    await request(`discover-${index}`, commits[index]!, false, true);
  }
  lastRefreshAt = Date.now();
}
let replayOrigin = 0;
try {
  await request("seed", commits[0]!);
  await observe(0);
  await delay(0);
  events.length = 0;
  replayOrigin = clockNow();
  const before = resources();
  const started = performance.now();
  for (const [index, at] of [
    0, 300_000, 600_000, 605_000, 610_000, 1_200_000, 1_800_000,
  ].entries()) {
    const generation = index + 1;
    await advance(replayOrigin + at);
    command(origin, "update-ref", "refs/heads/main", commits[generation]!);
    rows.push({
      label: `push-${generation}`,
      nominalAt: at,
      logicalAt: clockNow(),
      actualAtMs: performance.now() - campaignStart,
    });
    if (generation === 3 || generation === 4) {
      await delay(5_000);
      continue;
    }
    await observe(generation);
    if (generation === 6) {
      // Arrival during a different-head refresh exercises foreground priority.
      await advance(armed?.at ?? clockNow());
      await delay(100);
      await request("during-prewarm-older", commits[5]!);
    }
    await advance(replayOrigin + at + 90_000);
    const waveBefore = resources();
    const waveStart = performance.now();
    await Promise.all([
      request(`head-${generation}-guest`, commits[generation]!),
      request(`head-${generation}-managed`, commits[generation]!, false),
      ...(generation === 5 ? [request("head-5-waiter", commits[generation]!)] : []),
    ]);
    rows.push({
      label: `wave-${generation}`,
      elapsedMs: performance.now() - waveStart,
      ...used(waveBefore),
    });
    if (generation === 2) {
      await request("recent-older", commits[1]!);
    }
    await advance(replayOrigin + at + 120_000);
  }
  rows.push({ label: "campaign", elapsedMs: performance.now() - started, ...used(before) });
  await delay(0);
} finally {
  prewarm?.stop();
  await scheduler.stop();
  unsubscribe();
  await fs.writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        sourceHead: command(process.cwd(), "rev-parse", "HEAD"),
        prewarm: Boolean(values.prewarm),
        node: process.version,
        replayOrigin,
        files: shape.length,
        payloadBytes: 1_100_004_000,
        commits,
        rows,
        events,
        errors,
        templates: await listTemplatesAsync(process.env),
      },
      null,
      2,
    ),
  );
  for (const entry of (await readRegistry({ env: process.env })).entries) {
    await retireSandboxDependencyBuilder(entry, () => {}, true);
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
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
  await drainGlobalSingletonLifecycleState();
}
assert.deepEqual(errors, [], "Background prewarm errors must be investigated");
