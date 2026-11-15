// Real watch owner on a synthetic workspace; bundle owner + helper siblings first.
// node --expose-gc directory-watch-main-thread-measure.mjs --root /fixture --seed
// node --expose-gc directory-watch-main-thread-measure.mjs --root /fixture \
//   --owner /candidate/directory-watch-host.mjs --hosted [--allocations]
// Bundle all three src/infra/directory-watch-{host,host.worker,parent.worker}.ts
// entrypoints with esbuild --bundle --platform=node --format=esm and
// --out-extension:.js=.mjs --outdir=<owner-directory> on each pinned revision.
// --interval-ms 1000 gives a 60-second event window; default 0 measures a burst.
// Warm helper admission and 60 actual file edits. Counts are JS fs API calls,
// including Node's Linux recursive fallback, not direct-native system calls.
// The fixture has 62,000 files / 1.116 GB; 1,350 are under 135 skill directories.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    owner: { type: "string" },
    seed: { type: "boolean" },
    hosted: { type: "boolean" },
    allocations: { type: "boolean" },
    events: { type: "string", default: "60" },
    "interval-ms": { type: "string", default: "0" },
  },
});
assert(values.root);
const root = path.resolve(values.root),
  skills = path.join(root, ".openclaw/sandbox-skills/skills");
if (values.seed) {
  await fs.promises.mkdir(root);
  const bytes = Buffer.alloc(18000, 120);
  for (let index = 0; index < 62000; index++) {
    const dir =
      index < 1350
        ? path.join(skills, `skill-${Math.floor(index / 10)}`)
        : path.join(root, "background", `dir-${Math.floor(index / 100)}`);
    if (index % 100 === 0 || index <= 1350) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    await fs.promises.writeFile(path.join(dir, `file-${index}.txt`), bytes);
  }
  await fs.promises.mkdir(path.join(root, "anchor"));
  console.log(
    JSON.stringify({
      files: 62000,
      bytes: 62000 * bytes.length,
      skillFiles: 1350,
      skillDirectories: 135,
    }),
  );
  process.exit(0);
}
assert(values.owner && global.gc);
assert.equal(
  process.platform,
  "linux",
  "The owner measurement uses Linux recursive watch and /proc CPU accounting",
);
const intervalMs = Number(values["interval-ms"]);
assert(Number.isSafeInteger(intervalMs) && intervalMs >= 0);
const children = [];
const spawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = spawn(...args);
  children.push(child);
  return child;
};
syncBuiltinESMExports();
const { watchDirectory } = await import(pathToFileURL(path.resolve(values.owner)).href);
const keeper = setTimeout(
  () => {
    throw new Error("Watch measurement deadline exceeded");
  },
  30000 + Number(values.events) * intervalMs,
);
const anchorReady = Promise.withResolvers();
const anchor = watchDirectory(path.join(root, "anchor"), () => anchorReady.resolve());
if (values.hosted) {
  await anchorReady.promise;
}
const readChildCpu = async () => {
  let ticks = 0;
  for (const child of children) {
    const fields = (await fs.promises.readFile(`/proc/${child.pid}/stat`, "utf8"))
      .split(") ")[1]
      .split(" ");
    ticks += Number(fields[11]) + Number(fields[12]);
  }
  return ticks * 10; // Linux fixture CLK_TCK is 100, verified with getconf.
};
const counters = {};
for (const name of [
  "accessSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "fstatSync",
  "readdirSync",
  "openSync",
  "closeSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
]) {
  const original = fs[name];
  const wrapped = (...args) => {
    counters[name] = (counters[name] ?? 0) + 1;
    return original(...args);
  };
  if (original.native) {
    wrapped.native = (...args) => {
      counters[`${name}.native`] = (counters[`${name}.native`] ?? 0) + 1;
      return original.native(...args);
    };
  }
  fs[name] = wrapped;
}
syncBuiltinESMExports();
const inspector = new Session();
inspector.connect();
const sum = (n) => n.selfSize + n.children.reduce((total, child) => total + sum(child), 0);
global.gc();
if (values.allocations) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 512,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const ready = Promise.withResolvers();
let event;
const baselineChildCpu = values.hosted ? await readChildCpu() : 0;
const startCpu = process.threadCpuUsage(),
  start = performance.now();
const watch = watchDirectory(
  skills,
  (kind, filename) => {
    if (filename === undefined) {
      ready.resolve();
    }
    if (event && filename === event.filename) {
      event.resolve();
    }
  },
  true,
);
const dispatchMs = performance.now() - start;
const dispatchCpu = process.threadCpuUsage(startCpu);
if (values.hosted) {
  await ready.promise;
}
const admissionMs = performance.now() - start;
const admissionCpu = process.threadCpuUsage(startCpu);
const admissionCalls = { ...counters };
for (const key of Object.keys(counters)) {
  delete counters[key];
}
const eventCpu = process.threadCpuUsage(),
  eventStart = performance.now();
for (let i = 0; i < Number(values.events); i++) {
  if (intervalMs) {
    await delay(Math.max(0, (i + 1) * intervalMs - (performance.now() - eventStart)));
  }
  const index = (i % 135) * 10;
  const filename = path.join(`skill-${Math.floor(index / 10)}`, `file-${index}.txt`);
  event = { ...Promise.withResolvers(), filename };
  await fs.promises.appendFile(path.join(skills, filename), "x");
  await event.promise;
}
const eventMs = performance.now() - eventStart;
const eventCpuUsed = process.threadCpuUsage(eventCpu);
const eventCalls = { ...counters };
const allocated = values.allocations
  ? sum((await inspector.post("HeapProfiler.stopSampling")).profile.head)
  : null;
const helperCpuMs = values.hosted ? (await readChildCpu()) - baselineChildCpu : null;
const output = {
  node: process.version,
  platform: process.platform,
  load: os.loadavg(),
  hosted: Boolean(values.hosted),
  events: Number(values.events),
  admissionMs,
  dispatchMs,
  dispatchCpuMs: (dispatchCpu.user + dispatchCpu.system) / 1000,
  admissionCpuMs: (admissionCpu.user + admissionCpu.system) / 1000,
  admissionCalls,
  eventMs,
  eventCpuMs: (eventCpuUsed.user + eventCpuUsed.system) / 1000,
  eventCalls,
  allocated,
  helperCpuMs,
};
watch.close();
anchor.close();
inspector.disconnect();
for (const child of children) {
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
    } else {
      child.once("exit", resolve);
    }
  });
}
clearTimeout(keeper);
console.log(JSON.stringify(output));
