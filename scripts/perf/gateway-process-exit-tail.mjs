// Synthetic, isolated Gateway proof. Run after pnpm build:ci-artifacts.
// node scripts/perf/gateway-process-exit-tail.mjs --output .local/exit-tail/run --plugins 24 --samples 5 --leak-ms 4800
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    profile: { type: "boolean", default: false },
    plugins: { type: "string", default: "24" },
    samples: { type: "string", default: "5" },
    "leak-ms": { type: "string", default: "0" },
  },
});
if (!values.output) {
  throw new Error("--output is required (new synthetic directory)");
}
const root = path.resolve(values.output);
await fs.mkdir(path.dirname(root), { recursive: true });
await fs.mkdir(root);
const count = Number(values.plugins);
const preload = path.join(root, "observe.mjs");
await fs.writeFile(
  preload,
  `
import {appendFileSync} from 'node:fs';
import {isMainThread} from 'node:worker_threads';
import {Session} from 'node:inspector';
process.env.EXIT_TAIL_ROOT_PID ??= String(process.pid);
if (isMainThread && process.pid === Number(process.env.EXIT_TAIL_ROOT_PID)) {
  const record = phase => appendFileSync(process.env.EXIT_TAIL_EVENTS, JSON.stringify({phase, at:performance.timeOrigin+performance.now(), cpu:process.cpuUsage(), memory:process.memoryUsage(), resources:process.getActiveResourcesInfo()})+'\\n');
  let clean = false;
  let profiler;
  const finishProfile=()=>{
    if(!profiler) return;
    profiler.post('HeapProfiler.stopSampling',(error,result)=>{
      if(!error){const sum=node=>node.selfSize+node.children.reduce((total,child)=>total+sum(child),0);appendFileSync(process.env.EXIT_TAIL_EVENTS,JSON.stringify({phase:'allocations',bytes:sum(result.profile.head)})+'\\n');}
    });
    profiler.disconnect();profiler=undefined;
  };
  const kill=process.kill;
  process.kill=function(pid,signal){if(clean&&pid===process.pid&&signal==='SIGTERM'){finishProfile();record('terminate');}return Reflect.apply(kill,this,[pid,signal]);};
  for (const stream of [process.stdout,process.stderr]) {
    const write = stream.write;
    stream.write = function(chunk,...args) {
      const result = Reflect.apply(write,this,[chunk,...args]);
      if (String(chunk).includes('[exit-tail] workload ready')) record('ready');
      if (!clean && String(chunk).includes('[shutdown] completed cleanly')) {
        clean = true;
        record('clean');
        if(${values.profile}){profiler=new Session();profiler.connect();profiler.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});}
        if (${Number(values["leak-ms"])}) setTimeout(()=>{},${Number(values["leak-ms"])});
      }
      return result;
    };
  }
  process.once('beforeExit',()=>{record('beforeExit');finishProfile();});
  process.once('exit',()=>record('exit'));
}
`,
);
const plugins = [];
for (let index = 0; index < count; index++) {
  const id = `exit-tail-${index}`;
  plugins.push(id);
  const directory = path.join(root, "plugins", id);
  await fs.mkdir(path.join(directory, "dist/ui"), { recursive: true });
  await fs.writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: id,
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
      controlUi: { entry: "dist/ui/index.js" },
      uiCapabilities: ["widget"],
    }),
  );
  await fs.writeFile(path.join(directory, "value.mts"), "export const value: number = 42;");
  await fs.writeFile(
    path.join(directory, "dist/ui/index.js"),
    "import './chunk.js'; export default {};",
  );
  await fs.writeFile(path.join(directory, "dist/ui/chunk.js"), "export const value=42;");
  await fs.writeFile(
    path.join(directory, "index.mjs"),
    `
import {value} from './value.mts';
import fs from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
export default {id:${JSON.stringify(id)}, register(api) {
  let worker, child;
  api.registerService({id:${JSON.stringify(id)}, async start() {
    if(value!==42) throw new Error('source transform failed');
    worker=new Worker("global.heap=Array.from({length:12},()=>new Array(1024*1024).fill(42));require('node:worker_threads').parentPort.postMessage('ready');setInterval(()=>{},10000)",{eval:true,execArgv:[]});
    const ready=once(worker,'message');
    child=spawn(process.execPath,['-e',"console.log('ready');setInterval(()=>{},10000)"],{stdio:['ignore','pipe','ignore']});
    await Promise.all([ready,once(child.stdout,'data')]);
    fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR,${JSON.stringify(id + ".ready")}),'ready');
    globalThis.exitTailReady=(globalThis.exitTailReady??0)+1;
    if(globalThis.exitTailReady===${count}) console.log('[exit-tail] workload ready');
  }, async stop() {
    const exited=once(child,'exit');child.kill();
    await Promise.all([exited,worker.terminate()]);
  }});
}};
`,
  );
}
for (let sample = 0; sample < Number(values.samples); sample++) {
  const directory = path.join(root, String(sample));
  await fs.mkdir(directory, { recursive: true });
  const port = 22000 + Math.floor(Math.random() * 20000);
  const config = {
    meta: { lastTouchedVersion: "2026.11.1", migrations: { skillWorkshopPlugin: true } },
    browser: { enabled: false },
    update: { checkOnStart: false },
    discovery: { mdns: { mode: "off" } },
    gateway: {
      port,
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
      controlUi: { enabled: true },
      tailscale: { mode: "off" },
    },
    plugins: {
      allow: plugins,
      load: { paths: [path.join(root, "plugins")] },
      entries: Object.fromEntries(plugins.map((id) => [id, { enabled: true }])),
      slots: { memory: "none" },
    },
    agents: { defaults: { workspace: path.join(directory, "workspace") } },
    logging: { file: path.join(directory, "gateway.jsonl"), level: "info", consoleLevel: "info" },
  };
  const configPath = path.join(directory, "openclaw.json");
  const events = path.join(directory, "events.jsonl");
  await fs.writeFile(configPath, JSON.stringify(config));
  const log = await fs.open(path.join(directory, "gateway.log"), "w");
  const started = performance.timeOrigin + performance.now();
  const child = spawn(
    process.execPath,
    ["openclaw.mjs", "gateway", "run", "--allow-unconfigured"],
    {
      stdio: ["ignore", log.fd, log.fd],
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: process.env.TMPDIR,
        OPENCLAW_STATE_DIR: directory,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        EXIT_TAIL_EVENTS: events,
        NODE_OPTIONS: `${process.env.EXIT_TAIL_PROOF_NODE_OPTIONS ?? ""} --import=${preload}`,
      },
    },
  );
  const ended = once(child, "exit").then(([code, signal]) => ({
    code,
    signal,
    at: performance.timeOrigin + performance.now(),
  }));
  try {
    const deadline = Date.now() + 240_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode) {
        throw new Error("Gateway exited during startup");
      }
      try {
        if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) {
          break;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error("Gateway readiness timed out");
      }
      await delay(100);
    }
    const catalogStarted = performance.now();
    const bootstrap = await (await fetch(`http://127.0.0.1:${port}/control-ui-config.json`)).text();
    const catalogMs = performance.now() - catalogStarted;
    if (!plugins.every((id) => bootstrap.includes(id))) {
      throw new Error("Browser catalog did not load every plugin");
    }
    for (;;) {
      const ready = await Promise.all(
        plugins.map((id) =>
          fs.access(path.join(directory, `${id}.ready`)).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (ready.every(Boolean)) {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("Plugin services did not become ready");
      }
      await delay(100);
    }
    const processTable = () =>
      process.platform === "win32"
        ? []
        : execFileSync("ps", ["-axo", "pid,ppid,state,rss,command"], { encoding: "utf8" })
            .trim()
            .split("\n")
            .slice(1);
    const table = processTable();
    const owned = new Set([child.pid]);
    for (let previous = 0; previous !== owned.size;) {
      previous = owned.size;
      for (const line of table) {
        const [pid, parent] = line.trim().split(/\s+/).map(Number);
        if (owned.has(parent)) {
          owned.add(pid);
        }
      }
    }
    owned.delete(child.pid);
    const children = table
      .filter((line) => owned.has(Number(line.trim().split(/\s+/)[0])))
      .join("\n");
    await fs.writeFile(path.join(directory, "children.txt"), children);
    child.kill("SIGTERM");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 95_000);
    const exit = await ended;
    clearTimeout(watchdog);
    const records = (await fs.readFile(events, "utf8")).trim().split("\n").map(JSON.parse);
    const clean = records.find((event) => event.phase === "clean");
    if (!clean) {
      throw new Error("Gateway did not report clean shutdown");
    }
    const result = {
      sample,
      plugins: count,
      leakMs: Number(values["leak-ms"]),
      tailMs: exit.at - clean.at,
      startupMs: records.find((event) => event.phase === "ready")?.at - started,
      catalogMs,
      remainingChildren: processTable().filter((line) =>
        owned.has(Number(line.trim().split(/\s+/)[0])),
      ),
      exit,
      records,
      children,
    };
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    // The fixture owns this process group, including children left by a failed startup.
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error("Failed to stop fixture process group", error);
          process.exitCode = 1;
        }
      }
    }
    if (child.exitCode === null && !child.signalCode) {
      child.kill("SIGKILL");
      await ended;
    }
    await log.close();
  }
}
