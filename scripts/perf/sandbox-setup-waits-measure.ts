/**
 * Sandbox run-start owner proof with real session/worktree storage, Git checkouts,
 * workspace reconciliation and skill delivery. Only the container executable is a
 * synthetic process: --cli-delay-ms models engine latency without a daemon.
 *
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-setup-waits-measure.ts \
 *   --output .local/sandbox-setup-candidate.json --agents 32 --worktrees 320 \
 *   --iterations 5 --cli-delay-ms 200
 * Repeat on baseline/candidate in counterbalanced order; add --allocations for a
 * separate sampled-allocation pass. --iterations counts warm starts after one cold
 * creation. --expired-runtimes (default 32) exercises first-start pruning. Setup,
 * seeding, and cleanup are outside measurements. No forced GC. Requires Python 3.
 * --backend podman uses a synthetic local rootless Podman engine (default: docker).
 * After each setup sample, drain housekeeping separately and report its remaining
 * duration/CPU plus cumulative subprocess counts, before resetting counters. Setup
 * measurements include any housekeeping already running in that same window.
 * A production-owned skill snapshot is prepared before the measured starts.
 * --registry-iterations 2000 also compares the eliminated runtime-ID query with
 * a no-query loop on the same seeded state. This is deleted-work cost, not a
 * whole-setup speedup; use a separate --allocations run for allocation numbers.
 *
 * All state is synthetic and removed on exit. No Gateway, model turns, real engine,
 * browser or credentials are used. This isolates setup awaits; it does not prove
 * whole-Gateway latency or production filesystem/daemon latency. Background
 * worktrees are real tiny Git checkouts, not production-size repositories.
 * Spans are inclusive and may overlap; do not sum nested span totals.
 */
import assert from "node:assert/strict";
import { hash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    backend: { type: "string", default: "docker" },
    agents: { type: "string", default: "32" },
    worktrees: { type: "string", default: "320" },
    iterations: { type: "string", default: "5" },
    "cli-delay-ms": { type: "string", default: "200" },
    "expired-runtimes": { type: "string", default: "32" },
    "registry-iterations": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
const integer = (
  name:
    | "agents"
    | "worktrees"
    | "iterations"
    | "cli-delay-ms"
    | "expired-runtimes"
    | "registry-iterations",
  min = 1,
) => parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const agents = integer("agents");
const worktrees = integer("worktrees");
const iterations = integer("iterations");
const cliDelayMs = integer("cli-delay-ms", 0);
const expiredRuntimes = integer("expired-runtimes", 0);
const registryIterations = integer("registry-iterations", 0);
const backend = values.backend;
assert(backend === "docker" || backend === "podman", "--backend must be docker or podman");
const sourceHashes = Object.fromEntries(
  await Promise.all(
    (
      [
        ["context", "../../src/agents/sandbox/context.ts"],
        ["backend", "../../src/agents/sandbox/backend.ts"],
        ["docker", "../../src/agents/sandbox/docker.ts"],
        ["dockerBackend", "../../src/agents/sandbox/docker-backend.ts"],
        ["dockerPersistentTarget", "../../src/agents/sandbox/docker-persistent-target.ts"],
        ["podmanRuntime", "../../src/agents/sandbox/podman-runtime.ts"],
        ["localWorkspace", "../../src/agents/sandbox/local-workspace.ts"],
        ["localWorkspaceQuiescence", "../../src/agents/sandbox/local-workspace-quiescence.ts"],
        ["prune", "../../src/agents/sandbox/prune.ts"],
        ["skillsSync", "../../src/skills/loading/workspace-skill-sync.runtime.ts"],
        ["registry", "../../src/agents/sandbox/registry.ts"],
        ["harness", "./sandbox-setup-waits-measure.ts"],
      ] as const
    ).map(async ([name, relative]) => [
      name,
      hash("sha256", await fs.readFile(new URL(relative, import.meta.url))),
    ]),
  ),
);
assert(worktrees >= agents, "--worktrees must be at least --agents");
const output = path.resolve(values.output ?? ".local/sandbox-setup-waits.json");
await fs.mkdir(path.dirname(output), { recursive: true });
const fixture = await fs.mkdtemp(path.join(path.dirname(output), "sandbox-setup-fixture-"));
const bin = path.join(fixture, "bin");
const engines = path.join(fixture, "engines");
const callsFile = path.join(fixture, "engine-calls");
const gitTraceFile = path.join(fixture, "git-trace.jsonl");
async function readSubprocessCounts() {
  const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean);
  const subprocesses = Object.fromEntries(
    [...new Set(calls)].map((operation) => [
      operation,
      calls.filter((call) => call === operation).length,
    ]),
  );
  const gitSubprocesses = (await fs.readFile(gitTraceFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string })
    .filter((event) => event.event === "start").length;
  return { subprocesses, gitSubprocesses, totalSubprocesses: calls.length + gitSubprocesses };
}
await fs.mkdir(bin);
await fs.mkdir(engines);
Object.assign(process.env, {
  HOME: fixture,
  USERPROFILE: fixture,
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_CONFIG_PATH: path.join(fixture, "openclaw.json"),
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(fixture, "bundled-skills"),
  OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture, "bundled-plugins"),
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TRACE2_EVENT: gitTraceFile,
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  SANDBOX_WAIT_ENGINE_DIR: engines,
  SANDBOX_WAIT_CALLS: callsFile,
  SANDBOX_WAIT_DELAY_MS: String(cliDelayMs),
});
for (const name of [
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
]) {
  delete process.env[name];
}
await fs.writeFile(
  path.join(bin, backend),
  `#!/usr/bin/env python3
import hashlib, json, os, pathlib, sys, time
engine = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
if args[:1] == ['--host']: args = args[2:]
op = args[0]
with open(os.environ['SANDBOX_WAIT_CALLS'], 'a') as calls: calls.write(op + '\\n')
time.sleep(float(os.environ['SANDBOX_WAIT_DELAY_MS']) / 1000)
root = pathlib.Path(os.environ['SANDBOX_WAIT_ENGINE_DIR'])
def read(name):
    file = root / name
    if not file.exists():
        print('No such container ' + name, file=sys.stderr)
        sys.exit(1)
    return json.loads(file.read_text())
def write(state):
    for key in ['name', 'id']: (root / state[key]).write_text(json.dumps(state))
if op == 'context': print('{"Host":"unix:///synthetic-sandbox.sock"}')
elif op == 'info': print('true\\tfalse\\t\\t5.0.0' if engine == 'podman' else 'synthetic-daemon')
elif op in ['image', 'ps']: pass
elif op == 'create':
    name = args[args.index('--name') + 1]
    labels = [arg.split('=', 1)[1] for arg in args if arg.startswith('openclaw.configHash=')]
    state = dict(name=name, id=hashlib.sha256(name.encode()).hexdigest(), running=False, paused=False, configHash=labels[0])
    write(state)
    print(state['id'])
elif op == 'inspect':
    state = read(args[-1])
    form = args[2]
    if '.Mounts' in form: print('{"Mounts":[],"Tmpfs":{}}')
    elif form == '{{json .State}}': print(json.dumps(dict(Running=state['running'], Paused=state['paused'], Pid=123 if state['running'] else 0, StartedAt='2026-01-01T00:00:00Z')))
    else:
        fields = {'{{.Id}}':state['id'], '{{.State.Running}}':str(state['running'] and (engine != 'podman' or not state['paused'])).lower(), '{{.State.Paused}}':str(state['paused']).lower(), '{{.HostConfig.ReadonlyRootfs}}':'true', '{{ index .Config.Labels "openclaw.configHash" }}':state['configHash']}
        for key, value in fields.items(): form = form.replace(key, value)
        if '{{' in form: raise RuntimeError('Unsupported synthetic inspection')
        print(form)
elif op in ['start', 'pause', 'unpause', 'rm']:
    state = read(args[-1])
    if op == 'rm':
        for key in ['name', 'id']: (root / state[key]).unlink()
    else:
        if op == 'start': state['running'] = True
        else: state['paused'] = op == 'pause'
        write(state)
elif op == 'exec':
    if args[-2:] != ['cat', '/proc/self/mountinfo']: raise RuntimeError('Only mountinfo execution is supported')
    print('1 0 8:1 / / rw - ext4 /dev/synthetic rw')
else: raise RuntimeError('Unsupported synthetic operation: ' + op)
`,
  { mode: 0o700 },
);

const { requireGit } = await import("../../src/agents/worktrees/git.js");
const { insertRegistryWorktree } = await import("../../src/agents/worktrees/registry.js");
const { upsertSessionEntryCore } = await import("../../src/config/sessions/session-accessor.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { resolveSandboxContext } = await import("../../src/agents/sandbox/context.js");
const { maybePruneSandboxes } = await import("../../src/agents/sandbox/prune.js");
const { updateRegistry, readRegistry, readRegisteredSandboxRuntimeIds } =
  await import("../../src/agents/sandbox/registry.js");
const { withDiagnosticsTimelineObserver } = await import("../../src/infra/diagnostics-timeline.js");
const { onWorkerRequestMetrics } = await import("../../src/infra/worker-request-diagnostics.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const { openOpenClawStateDatabase } = await import("../../src/state/openclaw-state-db.js");
const { resolveReusableWorkspaceSkillSnapshot } =
  await import("../../src/skills/runtime/session-snapshot.js");
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const inspector = values.allocations ? new Session() : undefined;
try {
  openOpenClawStateDatabase();
  const repository = path.join(fixture, "repository");
  await fs.mkdir(repository);
  await git(repository, "init", "--quiet", "-b", "main");
  await fs.writeFile(path.join(repository, "source.txt"), "Synthetic source\n");
  for (let skill = 0; skill < 40; skill++) {
    const directory = path.join(repository, "skills", `fixture-${skill}`);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: fixture-${skill}\ndescription: Synthetic fixture\n---\nSynthetic skill\n`,
    );
  }
  await git(repository, "add", ".");
  await git(repository, "commit", "--quiet", "-m", "synthetic fixture");
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
  for (let index = 0; index < agents; index++) {
    const agentId = `synthetic-${index}`;
    const workspace = path.join(fixture, "agents", agentId);
    await fs.mkdir(workspace, { recursive: true });
    entries[agentId] = { workspace };
    for (let skill = 0; skill < 40; skill++) {
      const skillDir = path.join(workspace, "skills", `fixture-${skill}`);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: fixture-${skill}\ndescription: Synthetic fixture\n---\nSynthetic skill\n`,
      );
    }
  }
  const config: OpenClawConfig = {
    diagnostics: { enabled: true },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    worktreeAcceleration: false,
    agents: {
      entries,
      defaults: {
        skipBootstrap: true,
        sandbox: {
          mode: "all",
          backend,
          scope: "session",
          workspaceAccess: "none",
          prune: { idleHours: 24, maxAgeDays: 7 },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  const selections: { agentId: string; sessionKey: string; workspaceDir: string }[] = [];
  for (let index = 0; index < worktrees; index++) {
    const agentId = `synthetic-${Math.floor((index * agents) / worktrees)}`;
    const sessionKey = `agent:${agentId}:dashboard:synthetic-${index}`;
    const id = randomUUID();
    const directory = path.join(fixture, "worktrees", String(index));
    const branch = `openclaw/synthetic-${index}`;
    await git(repository, "worktree", "add", "--quiet", "-b", branch, directory);
    await insertRegistryWorktree(
      process.env,
      {
        id,
        name: `synthetic-${index}`,
        repoFingerprint: "synthetic",
        repoRoot: repository,
        path: directory,
        branch,
        baseRef: "main",
        ownerKind: "session",
        ownerId: sessionKey,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      },
      { provisionedPaths: [] },
    );
    await upsertSessionEntryCore(
      { agentId, sessionKey },
      {
        sessionId: randomUUID(),
        updatedAt: Date.now(),
        sandbox: "required",
        spawnedCwd: directory,
        sessionRoot: directory,
        worktree: { id, branch, repoRoot: repository, canonicalWorkspaceDir: repository },
      },
    );
    selections.push({ agentId, sessionKey, workspaceDir: directory });
  }
  for (let index = 0; index < expiredRuntimes; index++) {
    const name = `synthetic-expired-${index}`;
    const id = hash("sha256", name);
    const engineState = JSON.stringify({
      name,
      id,
      running: false,
      paused: false,
      configHash: "expired",
    });
    await fs.writeFile(path.join(engines, name), engineState);
    await fs.writeFile(path.join(engines, id), engineState);
    await updateRegistry({
      containerName: name,
      backendId: backend,
      runtimeLabel: name,
      backendTarget:
        backend === "podman"
          ? { key: "local", globalArgs: [] }
          : {
              key: "docker:synthetic-daemon",
              globalArgs: ["--host", "unix:///synthetic-sandbox.sock"],
            },
      sessionKey: `agent:synthetic-${index % agents}:dashboard:expired-${index}`,
      image: "synthetic",
      createdAtMs: Date.now() - 8 * 86400_000,
      lastUsedAtMs: Date.now() - 8 * 86400_000,
    });
  }
  const results = [];
  const registryQuery = [];
  let measuredRuntimeId: string | undefined;
  const selected = selections[0]!;
  const { snapshot: skillsSnapshot } = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: entries[selected.agentId]!.workspace!,
    executionWorkspaceDir: selected.workspaceDir,
    executionWorkspaceFileHost: "gateway",
    config,
    agentId: selected.agentId,
    watch: false,
  });
  assert.equal(skillsSnapshot.skills.length, 40, "Expected the prepared 40-skill snapshot");
  inspector?.connect();
  for (let index = 0; index <= iterations; index++) {
    // The same session permits a direct cold-versus-warm comparison. Other
    // registered worktrees exercise the production roster/registry query shape.
    await fs.writeFile(callsFile, "");
    await fs.writeFile(gitTraceFile, "");
    const spans: Record<string, { count: number; totalMs: number }> = {};
    const workerRequests: Record<string, { count: number; queueMs: number; workMs: number }> = {};
    const unsubscribe = onWorkerRequestMetrics(
      (kind, requestClass, phase, _depth, queueMs, durationMs) => {
        const key = `${kind}.${requestClass}`;
        const stats = (workerRequests[key] ??= { count: 0, queueMs: 0, workMs: 0 });
        if (phase === "queued") {
          stats.count++;
        }
        if (phase === "started") {
          stats.queueMs += queueMs ?? 0;
        }
        if (phase === "completed") {
          stats.workMs += durationMs ?? 0;
        }
      },
    );
    if (inspector) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const loadBefore = os.loadavg();
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    try {
      const sandbox = await withDiagnosticsTimelineObserver(
        (name, _attributes, durationMs) => {
          const start = performance.now();
          return () => {
            const stats = (spans[name] ??= { count: 0, totalMs: 0 });
            stats.count++;
            stats.totalMs += durationMs ?? performance.now() - start;
          };
        },
        () => resolveSandboxContext({ ...selected, config, skillsSnapshot }),
      );
      try {
        assert(sandbox?.workspaceSource === "managed-worktree", "Expected managed workspace setup");
        assert.equal(sandbox.skillUsagePaths?.length, 40, "Expected all 40 skills delivered");
        measuredRuntimeId = sandbox.runtimeId;
      } finally {
        sandbox?.[Symbol.dispose]?.();
      }
    } finally {
      unsubscribe();
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();
    const loadAfter = os.loadavg();
    const profile = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const measuredSubprocesses = await readSubprocessCounts();
    if (inspector) {
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const housekeepingCpuBefore = process.threadCpuUsage();
    const housekeepingStarted = performance.now();
    await maybePruneSandboxes(config);
    const housekeepingElapsedMs = performance.now() - housekeepingStarted;
    const housekeepingCpu = process.threadCpuUsage(housekeepingCpuBefore);
    const housekeepingProfile = inspector
      ? (await inspector.post("HeapProfiler.stopSampling")).profile
      : undefined;
    const afterHousekeeping = await readSubprocessCounts();
    const housekeeping = {
      elapsedMs: housekeepingElapsedMs,
      mainThreadCpuMs: (housekeepingCpu.user + housekeepingCpu.system) / 1000,
      sampledBytes: housekeepingProfile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      additionalSubprocesses:
        afterHousekeeping.totalSubprocesses - measuredSubprocesses.totalSubprocesses,
      ...afterHousekeeping,
    };
    results.push({
      cohort: index === 0 ? "cold" : "warm",
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
      spans,
      workerRequests,
      ...measuredSubprocesses,
      housekeeping,
      memoryBefore,
      memoryAfter,
      loadBefore,
      loadAfter,
    });
    console.log(
      JSON.stringify({
        cohort: index === 0 ? "cold" : "warm",
        elapsedMs,
        ...measuredSubprocesses,
        housekeeping,
        workerRequests,
      }),
    );
  }
  if (registryIterations) {
    const runtime = (await readRegistry()).entries.find(
      (entry) => entry.containerName === measuredRuntimeId,
    );
    assert(runtime, "Expected the measured runtime in the registry");
    const query = { backendId: backend, scopeKey: runtime.sessionKey };
    assert.equal((await readRegisteredSandboxRuntimeIds(query)).length, 1);
    for (const arm of ["read", "removed"] as const) {
      if (inspector) {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      let requests = 0;
      const unsubscribe = onWorkerRequestMetrics((_kind, _class, phase) => {
        if (phase === "queued") {
          requests++;
        }
      });
      const cpuBefore = process.threadCpuUsage();
      const started = performance.now();
      try {
        for (let index = 0; index < registryIterations; index++) {
          if (arm === "read") {
            await readRegisteredSandboxRuntimeIds(query);
          }
        }
      } finally {
        unsubscribe();
      }
      const elapsedMs = performance.now() - started;
      const cpu = process.threadCpuUsage(cpuBefore);
      const profile = inspector
        ? (await inspector.post("HeapProfiler.stopSampling")).profile
        : undefined;
      registryQuery.push({
        arm,
        iterations: registryIterations,
        elapsedMs,
        mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
        sampledBytes: profile?.samples.reduce((sum, sample) => sum + sample.size, 0),
        workerRequests: requests,
      });
    }
  }
  await fs.writeFile(
    output,
    `${JSON.stringify({ sourceHashes, backend, agents, worktrees, skillsPerAgent: 40, preparedSkillsSnapshot: true, expiredRuntimes, iterations, cliDelayMs, sampled: values.allocations, limitations: "Owner setup only; no Gateway transport/model turns. Small repositories; synthetic engine does not execute tools. Nested spans overlap. Worker totals include process-wide work during setup, including already-running requests completing in the window. Housekeeping drains after each setup sample; its counts are cumulative so work is not hidden or charged to the next sample. registryQuery is the isolated eliminated-query cost, not whole-setup improvement.", results, registryQuery }, null, 2)}\n`,
  );
  console.log(`Saved ${output}`);
} finally {
  inspector?.disconnect();
  await drainGlobalSingletonLifecycleState();
  await fs.rm(fixture, { recursive: true, force: true });
}
