// Standalone Node worker start/terminate diagnostic; no OpenClaw modules or native addons.
// node --expose-gc scripts/perf/node-worker-churn-measure.mjs [noop|allocation|vm] [cycles=1000]
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
const mode = process.argv[2] ?? "noop";
const cycles = Number(process.argv[3] ?? 1000);
assert(["noop", "allocation", "vm"].includes(mode));
assert(Number.isSafeInteger(cycles) && cycles > 0);
const source = `
const { parentPort } = require('node:worker_threads');
const { getHeapStatistics } = require('node:v8');
const mode = ${JSON.stringify(mode)};
if (mode === 'allocation') globalThis.items = Array.from({length:10000}, (_,i)=>({i, text:'fixture-'+i, values:[i,i+1,i+2]}));
if (mode === 'vm') { const vm = require('node:vm'); for(let i=0;i<20;i++) vm.runInNewContext('Array.from({length:1000}, (_,i)=>({i,text:"fixture"+i}))', {}); }
const cpu = process.threadCpuUsage();
parentPort.postMessage({ cpuMs:(cpu.user+cpu.system)/1000, allocatedBytes:getHeapStatistics().total_allocated_bytes });
parentPort.on('message', () => {});
`;
let workerCpuMs = 0,
  allocatedBytes = 0;
const cpu = process.cpuUsage();
const mainCpu = process.threadCpuUsage();
const start = performance.now();
const snapshots = [];
async function sample(cycle) {
  globalThis.gc();
  await delay(50);
  const memory = process.memoryUsage();
  snapshots.push({
    cycle,
    elapsedMs: performance.now() - start,
    ...memory,
    residualBytes: memory.rss - memory.heapTotal - memory.external,
    load: loadavg(),
  });
}
await sample(0);
for (let cycle = 1; cycle <= cycles; cycle++) {
  const worker = new Worker(source, { eval: true, execArgv: [], env: {} });
  const [result] = await once(worker, "message");
  workerCpuMs += result.cpuMs;
  allocatedBytes += result.allocatedBytes;
  await worker.terminate();
  if (cycle % 100 === 0 || cycle === cycles) {
    await sample(cycle);
  }
}
await delay(1000);
await sample(cycles);
const total = process.cpuUsage(cpu),
  main = process.threadCpuUsage(mainCpu);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      mode,
      cycles,
      workerCpuMs,
      allocatedBytes,
      processCpuMs: (total.user + total.system) / 1000,
      mainCpuMs: (main.user + main.system) / 1000,
      snapshots,
    },
    null,
    2,
  ),
);
