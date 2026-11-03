/**
 * Process-backed prepared Podman execution, without real containers or user state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/podman-exec-measure.ts \
 *   --root /absolute/scratch/run-a --commands 20 --report report.json
 * Run >=5 serial A/B pairs plus A/A controls with the same command count. Use
 * --source-root for a pinned baseline checkout and --verify-binding on the fix.
 * --cpu-profile captures only warm main-thread execution. Preparation is reported separately;
 * measured turns run both shell and exec-spec paths through real child processes.
 * Workspace/database size does not affect this path: no workspace scan occurs.
 * This qualifies spawn overhead, not Podman/btrfs or full Gateway turn latency.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    commands: { type: "string", default: "20" },
    turns: { type: "string", default: "5" },
    report: { type: "string", default: "report.json" },
    "source-root": { type: "string", default: process.cwd() },
    "verify-binding": { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.root && path.isAbsolute(values.root), "--root must be an unused absolute path");
const root = values.root;
const commands = Number(values.commands);
const turns = Number(values.turns);
assert(Number.isSafeInteger(commands) && commands > 0);
assert(Number.isSafeInteger(turns) && turns > 0);
fs.mkdirSync(root);
const workspace = path.join(root, "workspace");
const bin = path.join(root, "bin");
for (const directory of [workspace, bin, path.join(root, "tmp")]) {
  fs.mkdirSync(directory);
}
const calls = path.join(root, "calls.jsonl");
const engineState = path.join(root, "container.json");
const unavailable = path.join(root, "unavailable");
fs.writeFileSync(calls, "");
fs.writeFileSync(path.join(workspace, "input.txt"), "synthetic-podman-exec\n");
fs.writeFileSync(
  path.join(bin, "podman"),
  String.raw`#!/usr/bin/env python3
import hashlib, json, os, pathlib, subprocess, sys
state = pathlib.Path(${JSON.stringify(engineState)})
calls = pathlib.Path(${JSON.stringify(calls)})
workspace = ${JSON.stringify(workspace)}
args = sys.argv[1:]
bound = False
if args[:1] == ['--remote=false']:
    bound = True
    args = args[1:]
elif args[:1] == ['--url']:
    bound = True
    args = args[2:]
    if args[:1] == ['--identity']: args = args[2:]
op = args[0]
with calls.open('a') as out: out.write(json.dumps(dict(op=op, argv=sys.argv[1:], pid=os.getpid())) + '\n')
if pathlib.Path(${JSON.stringify(unavailable)}).exists():
    print('Error: fixture Podman engine unavailable; restore the original engine before retrying', file=sys.stderr)
    sys.exit(125)
remote = not bound and bool(os.environ.get('CONTAINER_HOST') or os.environ.get('CONTAINER_CONNECTION'))
if op == 'info':
    print('true\t' + str(remote).lower() + '\t\t5.0.0')
    sys.exit(0)
if op == 'system':
    print(json.dumps([dict(Name='changed', URI='ssh://remote.invalid/run/podman.sock', Default=True)]))
    sys.exit(0)
if remote:
    print('Error: unbound execution followed the changed remote connection', file=sys.stderr)
    sys.exit(125)
def read(target):
    if state.exists():
        value = json.loads(state.read_text())
        if target in [value['name'], value['id']]: return value
    print('No such container ' + target, file=sys.stderr)
    sys.exit(1)
if op == 'image': print('sha256:' + 'a' * 64)
elif op == 'create':
    name = args[args.index('--name') + 1]
    mounts = []
    for i, arg in enumerate(args):
        if arg == '-v':
            source, destination, options = args[i+1].rsplit(':', 2)
            mounts.append(dict(Type='bind', Source=source, Destination=destination, RW='ro' not in options.split(',')))
    value = dict(name=name, id=hashlib.sha256(name.encode()).hexdigest(), running=False, mounts=mounts,
                 configHash=next(arg.split('=', 1)[1] for arg in args if arg.startswith('openclaw.configHash=')))
    state.write_text(json.dumps(value))
    print(value['id'])
elif op == 'start':
    value = read(args[-1]); value['running'] = True; state.write_text(json.dumps(value))
elif op == 'inspect':
    value = read(args[-1])
    form = args[args.index('--format') + 1] if '--format' in args else args[args.index('-f') + 1]
    fields = {'{{.Id}}':value['id'], '{{.State.Running}}':str(value['running']).lower(),
              '{{.HostConfig.ReadonlyRootfs}}':'true', '{{ index .Config.Labels "openclaw.configHash" }}':value['configHash'],
              '{{json .Mounts}}':json.dumps(value['mounts']), '{{json .HostConfig.Tmpfs}}':'{}'}
    for key, field in fields.items(): form = form.replace(key, field)
    if '{{' in form: raise RuntimeError('Unsupported inspection: ' + form)
    print(form)
elif op == 'exec':
    args = args[1:]
    env = dict(os.environ)
    while args[0].startswith('-'):
        flag = args.pop(0)
        if flag in ['-i', '-t']: continue
        arg = args.pop(0)
        if flag == '--env-file':
            for line in pathlib.Path(arg).read_text().splitlines():
                name, value = line.split('=', 1); env[name] = value
        elif flag != '-w': raise RuntimeError('Unsupported exec flag: ' + flag)
    value = read(args.pop(0))
    if args == ['cat', '/proc/self/mountinfo']:
        print('1 1 0:1 / / ro - overlay overlay ro')
        for i, mount in enumerate(value['mounts'], 2):
            mode = 'rw' if mount['RW'] else 'ro'
            print(f"{i} 1 0:{i} / {mount['Destination']} {mode} - fixture fixture {mode}")
    else:
        # Execute the actual safe workload; no fabricated shell success/output.
        sys.exit(subprocess.run(args, cwd=workspace, env=env).returncode)
else: raise RuntimeError('Unsupported operation: ' + op)
`,
  { mode: 0o700 },
);
const configPath = path.join(root, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(root, "state"), TMPDIR: path.join(root, "tmp") },
});
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
for (const name of ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) {
  delete process.env[name];
}
const config: OpenClawConfig = {
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "podman",
        scope: "session",
        workspaceAccess: "none",
        browser: { enabled: false },
        docker: { image: "fixture:latest", workdir: "/workspace", tmpfs: [] },
      },
    },
  },
};
fs.writeFileSync(configPath, JSON.stringify(config));
const source = (file: string) => pathToFileURL(path.join(values["source-root"]!, file)).href;
const state = await import(source("src/state/openclaw-state-db.ts"));
(await import(source("src/config/runtime-snapshot.ts"))).setRuntimeConfigSnapshot(config);
state.openOpenClawStateDatabase();
const { resolveSandboxConfigForAgent } = await import(source("src/agents/sandbox/config.ts"));
const { createPodmanSandboxBackend } = await import(source("src/agents/sandbox/docker-backend.ts"));
const { spawnCommand } = await import(source("src/process/exec.ts"));
const readCalls = () =>
  fs
    .readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string });
async function measure<T>(run: () => Promise<T>) {
  const countBefore = readCalls().length;
  const load = loadavg();
  const allocated = getHeapStatistics().total_allocated_bytes;
  const cpu = process.threadCpuUsage();
  const totalCpu = process.cpuUsage();
  const start = performance.now();
  const value = await run();
  const wallMs = performance.now() - start;
  const thread = process.threadCpuUsage(cpu);
  const total = process.cpuUsage(totalCpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocated;
  const observed = readCalls().slice(countBefore);
  return {
    value,
    metrics: {
      wallMs,
      mainCpuMs: (thread.user + thread.system) / 1000,
      processCpuMs: (total.user + total.system) / 1000,
      allocatedBytes,
      load,
      spawns: observed.length,
      probes: observed.filter(({ op }) => op === "info").length,
      execs: observed.filter(({ op }) => op === "exec").length,
    },
  };
}
try {
  const prepared = await measure(() =>
    createPodmanSandboxBackend({
      sessionKey: "agent:main:fixture",
      scopeKey: "agent:main:fixture",
      workspaceDir: workspace,
      agentWorkspaceDir: workspace,
      cfg: resolveSandboxConfigForAgent(config),
    }),
  );
  const backend = prepared.value;
  const shell = async () => {
    const result = await backend.runShellCommand({ script: "cat input.txt" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), "synthetic-podman-exec\n");
  };
  const exec = async () => {
    const spec = await backend.buildExecSpec({ command: "cat input.txt", env: {}, usePty: false });
    try {
      const result = await spawnCommand(spec.argv, {
        baseEnv: spec.env,
        encoding: "utf8",
        reject: false,
      });
      assert.equal(result.exitCode, 0, String(result.stderr));
      assert.equal(result.stdout, "synthetic-podman-exec");
    } finally {
      await backend.finalizeExec?.({
        token: spec.finalizeToken,
        status: "completed",
        exitCode: 0,
        timedOut: false,
      });
    }
  };
  await shell();
  await exec();
  const profiler = values["cpu-profile"] ? new Session() : undefined;
  profiler?.connect();
  await profiler?.post("Profiler.enable");
  await profiler?.post("Profiler.start");
  const samples = [];
  for (let turn = 0; turn < turns; turn++) {
    global.gc?.();
    samples.push(
      (
        await measure(async () => {
          for (let i = 0; i < commands; i++) {
            await shell();
            await exec();
          }
        })
      ).metrics,
    );
  }
  if (profiler) {
    const { profile } = await profiler.post("Profiler.stop");
    profiler.disconnect();
    fs.writeFileSync(path.join(root, "exec.cpuprofile"), JSON.stringify(profile));
  }
  let binding: string | undefined;
  if (values["verify-binding"]) {
    process.env.CONTAINER_HOST = "ssh://remote.invalid/run/podman.sock";
    process.env.CONTAINER_CONNECTION = "changed";
    await shell();
    await exec();
    delete process.env.CONTAINER_CONNECTION;
    const rejected = createPodmanSandboxBackend({
      sessionKey: "agent:main:other",
      scopeKey: "agent:main:other",
      workspaceDir: workspace,
      agentWorkspaceDir: workspace,
      cfg: resolveSandboxConfigForAgent(config),
    });
    await assert.rejects(rejected, /active Podman connection is remote/iu);
    delete process.env.CONTAINER_HOST;
    delete process.env.CONTAINER_CONNECTION;
    fs.writeFileSync(unavailable, "");
    await assert.rejects(shell, /restore the original engine/iu);
    await assert.rejects(exec, /restore the original engine/iu);
    binding =
      "prepared execution stays local; new remote preparation rejected; lost engine reported";
  }
  const report = {
    sourceRoot: values["source-root"],
    node: process.version,
    commandsPerTurn: commands * 2,
    preparation: prepared.metrics,
    samples,
    binding,
  };
  fs.writeFileSync(path.resolve(root, values.report!), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await state.closeOpenClawStateDatabaseAsync();
  await (
    await import(source("src/shared/global-singleton.ts"))
  ).drainGlobalSingletonLifecycleState();
}
