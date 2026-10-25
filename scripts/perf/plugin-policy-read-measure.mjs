// Warm plugin policy reads; run on the approved benchmark host with an isolated HOME.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { PerformanceObserver, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay, setImmediate as turn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
function readResolver(indexFile) {
  const source = fs.readFileSync(indexFile, "utf8");
  const from = source.indexOf("    const resolvePluginConfig = ");
  const until = source.indexOf("    const resolveCurrentPluginConfig = ", from);
  assert(from !== -1 && until !== -1);
  const resolver = source.slice(from, until);
  return { resolver, hash: createHash("sha256").update(resolver).digest("hex") };
}

if (process.argv[2] === "--build") {
  const [sourceRoot, output] = process.argv.slice(3);
  assert(sourceRoot && output, "Usage: --build SOURCE_ROOT BUNDLE");
  const root = path.resolve(sourceRoot);
  const { resolver, hash } = readResolver(path.join(root, "extensions/codex/index.ts"));
  const { build } = await import("esbuild");
  await build({
    stdin: {
      contents: `
      import { normalizePluginsConfig, resolveEffectiveEnableState, resolveLivePluginConfigObject } from './src/plugin-sdk/plugin-config-runtime.js';
      export { prepareRuntimePluginsConfig } from './src/plugins/config-state.js';
      export { createPluginInstanceBindings } from './src/plugins/plugin-instance-bindings.js';
      export const codexResolverHash = ${JSON.stringify(hash)};
      export function createCodexResolver(api) { ${resolver} return resolvePluginConfig; }
    `,
      resolveDir: root,
      loader: "ts",
    },
    absWorkingDir: root,
    tsconfig: path.join(root, "tsconfig.json"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: path.resolve(output),
  });
  process.exit(0);
}
const [bundle, indexFile, workload, mode, output, ready, start, count = "200000"] =
  process.argv.slice(2);
assert(
  bundle && indexFile && output,
  "Usage: BUNDLE CODEX_INDEX config|bindings timing|allocation OUTPUT [READY START COUNT]",
);
assert(["config", "bindings"].includes(workload));
assert(["timing", "allocation"].includes(mode));
assert(global.gc, "Run with --expose-gc");
assert(
  !process.execArgv.some((arg) => arg.startsWith("--trace-gc")),
  "Use untraced timing and allocation runs",
);
const operations = Number(count);
assert(Number.isSafeInteger(operations) && operations > 0);
const owner = await import(pathToFileURL(path.resolve(bundle)).href);
const { hash: resolverHash } = readResolver(indexFile);
assert.equal(
  owner.codexResolverHash,
  resolverHash,
  "Bundle and Codex entry must use the same revision",
);
const payload = { appServer: { homeScope: "user" }, supervision: { enabled: true } };
const config = {
  plugins: {
    entries: Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        i === 0 ? "codex" : `plugin-${i}`,
        {
          enabled: true,
          config: i === 0 ? payload : { value: i },
          hooks: { allowPromptInjection: false },
          llm: { allowedModels: ["example/model"] },
        },
      ]),
    ),
  },
};
owner.prepareRuntimePluginsConfig(config);
const resolveConfig = owner.createCodexResolver({ pluginConfig: undefined });
let reads = 0;
const current = () => {
  reads++;
  return config;
};
// Metadata reads need no execution lease; real instance lifecycle behavior is covered by its tests.
const instance = { pluginId: "synthetic", lifecycle: { signal: new AbortController().signal } };
const run = (fn) => fn();
const bindings = owner.createPluginInstanceBindings({
  instance,
  enter: (_, fn) => fn(),
  invoke: run,
  lease: () => ({ token: {}, release() {} }),
  hasToken: () => true,
  isConsumerToken: () => false,
});
const wrap = bindings.create(run);
const policies = Array.from({ length: 40 }, (_, i) =>
  wrap({
    dangerous: i % 5 === 0,
    commands: [`command.${i}`],
    defaultPlatforms: ["linux", "darwin"],
  }),
);
let checksum = 0;
const operation =
  workload === "config"
    ? () => {
        assert.equal(resolveConfig(current), payload);
        checksum++;
      }
    : () => {
        for (const policy of policies) {
          if (policy.dangerous !== true && policy.defaultPlatforms.includes("linux")) {
            checksum += policy.commands[0].length;
          }
          if (policy.dangerous === true) {
            checksum += policy.commands.length;
          }
        }
      };
for (let i = 0; i < 2000; i++) {
  operation();
}
if (ready) {
  fs.writeFileSync(ready, "ready");
  while (!fs.existsSync(start)) {
    await delay(20);
  }
  const epoch = Number(fs.readFileSync(start, "utf8"));
  await delay(Math.max(0, epoch - Date.now()));
}
global.gc();
await turn();
checksum = 0;
reads = 0;
const gc = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gc.push({ kind: e.detail.kind, ms: e.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const session = new Session();
if (mode === "allocation") {
  session.connect();
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const elapsed = [];
const cpu0 = process.cpuUsage();
const wall0 = performance.now();
for (let i = 0; i < operations; i += 100) {
  const batchEnd = Math.min(i + 100, operations);
  const t = performance.now();
  for (let j = i; j < batchEnd; j++) {
    operation();
  }
  elapsed.push((performance.now() - t) / (batchEnd - i));
  await turn();
}
const wallMs = performance.now() - wall0;
const cpu = process.cpuUsage(cpu0);
await turn();
observer.disconnect();
loop.disable();
let sampledBytes;
if (mode === "allocation") {
  const { profile } = await session.post("HeapProfiler.stopSampling");
  fs.writeFileSync(output + ".heapprofile", JSON.stringify(profile));
  const sum = (n) => n.selfSize + n.children.reduce((a, c) => a + sum(c), 0);
  sampledBytes = sum(profile.head);
  session.disconnect();
}
const sortedElapsed = elapsed.toSorted((a, b) => a - b);
const quantile = (arr, p) =>
  arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
const kinds = Object.fromEntries(
  [1, 2, 4, 8, 16].map((kind) => {
    const v = gc
      .filter((x) => x.kind === kind)
      .map((x) => x.ms)
      .toSorted((a, b) => a - b);
    return [
      kind,
      {
        count: v.length,
        totalMs: v.reduce((a, b) => a + b, 0),
        p95: quantile(v, 0.95),
        p99: quantile(v, 0.99),
        maxMs: v.at(-1) ?? 0,
      },
    ];
  }),
);
assert.equal(checksum, workload === "config" ? operations : operations * 320);
if (workload === "config") {
  assert.equal(reads, operations);
}
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      bundle,
      workload,
      mode,
      operations,
      checksum,
      sourceHash: resolverHash,
      bundleHash: createHash("sha256").update(fs.readFileSync(bundle)).digest("hex"),
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      allocBytes: sampledBytes,
      allocBytesPerOp: sampledBytes / operations,
      gc: kinds,
      gcMsPerOp: gc.reduce((a, b) => a + b.ms, 0) / operations,
      latency: {
        samples: elapsed.length,
        p95: quantile(sortedElapsed, 0.95),
        p99: quantile(sortedElapsed, 0.99),
      },
      loop: {
        samples: loop.count,
        p95: loop.percentile(95) / 1e6,
        p99: loop.percentile(99) / 1e6,
        max: loop.max / 1e6,
      },
    },
    null,
    2,
  ),
);
