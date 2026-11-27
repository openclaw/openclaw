import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** A process-backed engine contract with a SIGTERM-ignoring builder and slow removal. */
export function installSandboxBuilderEngineFixture(
  root: string,
  removalMs: number,
  reopen = false,
) {
  const bin = path.join(root, "builder-engine-bin");
  const state = path.join(root, "builder-engine-state");
  const calls = path.join(root, "builder-engine-calls.jsonl");
  fs.mkdirSync(bin, { recursive: reopen });
  fs.mkdirSync(state, { recursive: reopen });
  if (!reopen) {
    fs.writeFileSync(calls, "");
  }
  fs.writeFileSync(
    path.join(bin, "podman"),
    String.raw`#!/usr/bin/env python3
import hashlib, json, os, pathlib, sys, time
root = pathlib.Path(${JSON.stringify(state)})
calls = pathlib.Path(${JSON.stringify(calls)})
args = sys.argv[1:]
if args[:1] == ['--remote=false']: args = args[1:]
if args[:1] == ['--url']: args = args[2:]
op = args[0]
def event(phase):
    with calls.open('a') as out: out.write(json.dumps(dict(op=op, args=args, phase=phase, pid=os.getpid(), at=time.time())) + '\n')
def read(target):
    for file in root.glob('*.json'):
        value = json.loads(file.read_text())
        if target in [value['name'], value['id']]: return value
    print('No such container ' + target, file=sys.stderr)
    sys.exit(1)
def write(value):
    file = root / (value['name'] + '.json')
    temporary = file.with_suffix('.tmp-' + str(os.getpid()))
    temporary.write_text(json.dumps(value))
    temporary.replace(file)
event('started')
if op == 'info': print('true\tfalse\t\t5.0.0')
elif op == 'image': print('sha256:' + 'a' * 64)
elif op == 'ps': pass
elif op == 'create':
    name = args[args.index('--name') + 1]
    if (root / (name + '.json')).exists(): raise RuntimeError('Name collision: ' + name)
    config = next(arg.split('=', 1)[1] for arg in args if arg.startswith('openclaw.configHash='))
    value = dict(name=name, id=hashlib.sha256(name.encode()).hexdigest(), running=False, paused=False, configHash=config)
    write(value)
    print(value['id'])
elif op == 'inspect':
    value = read(args[-1])
    form = args[2]
    if form == '{{json .State}}': print(json.dumps(dict(Running=value['running'], Paused=value['paused'], Pid=123 if value['running'] else 0)))
    else:
        fields = {'{{.Id}}':value['id'], '{{.State.Running}}':str(value['running']).lower(), '{{.State.Paused}}':str(value['paused']).lower(), '{{.HostConfig.ReadonlyRootfs}}':'true', '{{ index .Config.Labels "openclaw.configHash" }}':value['configHash']}
        for key, field in fields.items(): form = form.replace(key, field)
        if '{{' in form: raise RuntimeError('Unsupported inspection: ' + form)
        print(form)
elif op in ['start', 'kill', 'stop', 'wait', 'rm']:
    value = read(args[-1])
    if op == 'rm':
        time.sleep(${removalMs} / 1000)
        (root / (value['name'] + '.json')).unlink(missing_ok=True)
    elif op == 'wait':
        if value['running']: raise RuntimeError('Writer has not stopped')
        print(0)
    else:
        # Model PID 1 ignoring SIGTERM: stop must exhaust its grace before SIGKILL.
        # kill defaults to SIGKILL and has no stop grace, even without --init.
        if op == 'stop' and value['running']:
            grace = int(args[args.index('--time') + 1]) if '--time' in args else 10
            time.sleep(grace)
        value['running'] = op == 'start'
        value['paused'] = False
        write(value)
elif op == 'exec':
    # Deliberately exercise the real source-only fallback, without fabricating pnpm output.
    if 'pnpm install' not in args[-1]: raise RuntimeError('Unsupported execution')
    event('completed')
    sys.exit(1)
else: raise RuntimeError('Unsupported operation: ' + op)
event('completed')
`,
    { mode: 0o700 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  for (const name of ["CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY"]) {
    delete process.env[name];
  }
  const readEvents = () =>
    fs
      .readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { op: string; phase: string; pid: number; at: number });
  return {
    async interruptRemoval() {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const active = new Map<number, ReturnType<typeof readEvents>[number]>();
        for (const event of readEvents().filter((entry) => entry.op === "rm")) {
          if (event.phase === "started") {
            active.set(event.pid, event);
          } else {
            active.delete(event.pid);
          }
        }
        if (active.size) {
          for (const event of active.values()) {
            // These PIDs came from this fixture's still-running removal commands.
            process.kill(event.pid, "SIGKILL");
            fs.appendFileSync(calls, JSON.stringify({ ...event, phase: "interrupted" }) + "\n");
          }
          return [...active.keys()];
        }
        await delay(20);
      }
      throw new Error("No asynchronous builder removal to interrupt; increase the removal delay");
    },
    snapshot() {
      const events = readEvents();
      const completed: Record<string, number> = {};
      let removing = 0,
        maxConcurrentRemovals = 0;
      for (const event of events) {
        if (event.phase === "completed") {
          completed[event.op] = (completed[event.op] ?? 0) + 1;
        }
        if (event.op === "rm") {
          removing += event.phase === "started" ? 1 : -1;
          maxConcurrentRemovals = Math.max(maxConcurrentRemovals, removing);
        }
      }
      const remaining = fs
        .readdirSync(state)
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) =>
            JSON.parse(fs.readFileSync(path.join(state, name), "utf8")) as {
              name: string;
              running: boolean;
            },
        );
      assert(remaining.every((entry) => entry.name.startsWith("openclaw-deps-")));
      return { completed, maxConcurrentRemovals, remaining };
    },
  };
}
