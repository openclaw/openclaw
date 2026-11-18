/**
 * Diagnostic only: bare engines and production controller, without worker/owner transport.
 * Run from the workspace: node --import ./scripts/tsx.mjs
 * extensions/code-mode-quickjs/bench/engine-attribution.ts [rounds=40] [package-root]
 * An alternate package root qualifies a dependency without changing the workspace install.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, loadavg, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, Script } from "node:vm";
import { CODE_MODE_CONTROLLER_SOURCE } from "openclaw/plugin-sdk/code-mode-executor-runtime";
import * as installed from "quickjs-wasi";

const rounds = Number(process.argv[2] ?? 40);
assert(Number.isSafeInteger(rounds) && rounds >= 5 && rounds <= 200);
const require = createRequire(import.meta.url);
const packageRoot = process.argv[3] ?? dirname(require.resolve("quickjs-wasi/package.json"));
const { QuickJS }: typeof installed = await import(
  pathToFileURL(resolve(packageRoot, "dist/index.js")).href
);
const version = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;
const wasmBytes = readFileSync(resolve(packageRoot, "quickjs.wasm"));
const encodingBytes = readFileSync(resolve(packageRoot, "extensions/encoding/encoding.so"));
const compileAt = performance.now();
const wasm = await WebAssembly.compile(wasmBytes);
const encoding = await WebAssembly.compile(encodingBytes);
const compileMs = performance.now() - compileAt;
const options = {
  wasm,
  extensions: [{ name: "encoding", wasm: encoding }],
  memoryLimit: 64 * 1024 * 1024,
  maxStackSize: installed.MAX_STACK_SIZE,
  timezoneOffset: 0,
};
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Samples = Record<string, number[]>;
const samples: Samples = {};
function record(name: string, started: number) {
  (samples[name] ??= []).push(performance.now() - started);
}
function summary(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    n: values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
const loadStart = loadavg();
const nativeControllerAt = performance.now();
const nativeController = new Script(CODE_MODE_CONTROLLER_SOURCE);
const nativeControllerCompileMs = performance.now() - nativeControllerAt;
const compiler = await QuickJS.create(options);
const bytecodeAt = performance.now();
const controllerBytecode = compiler.compile(CODE_MODE_CONTROLLER_SOURCE, "controller.js");
const controllerBytecodeCompileMs = performance.now() - bytecodeAt;
compiler.dispose();

for (const catalogSize of [0, 16, 160, 1000]) {
  const catalog = Array.from({ length: catalogSize }, (_, index) => ({
    name: `tool_${index}`,
    callableName: `tool_${index}`,
    source: "openclaw",
    description: "Synthetic tool description ".repeat(8),
  }));
  const entries = [
    ["__openclawCatalog", catalog],
    ["__openclawNamespaces", []],
    ["__openclawApiFiles", []],
    ["__openclawSwarmEnabled", false],
    ["__openclawMaxPendingToolCalls", 16],
  ] as const;
  const nativeInput = new Script(
    `Object.assign(globalThis, JSON.parse(${JSON.stringify(JSON.stringify(Object.fromEntries(entries)))}))`,
  );
  for (let index = -3; index < rounds; index++) {
    const phase = (name: string, at: number) => {
      if (index >= 0) {
        record(`${catalogSize}/${name}`, at);
      }
    };
    let at = performance.now();
    const context = createContext(Object.create(null));
    phase("node/context", at);
    at = performance.now();
    nativeInput.runInContext(context);
    for (const name of [
      "__openclawHostRequest",
      "__openclawHostCancelRequest",
      "__openclawHostTakeBridgeReply",
      "__openclawHostObserveNetworkContent",
    ]) {
      context[name] = () => undefined;
    }
    phase("node/input", at);
    at = performance.now();
    nativeController.runInContext(context);
    phase("node/controller", at);
    assert.equal(new Script("6 * 7").runInContext(context), 42);
    // Counterbalance source and bytecode so neither always follows the other.
    for (const mode of index % 2 === 0 ? ["source", "bytecode"] : ["bytecode", "source"]) {
      at = performance.now();
      const vm = await QuickJS.create(options);
      phase(`quickjs-${mode}/create`, at);
      try {
        at = performance.now();
        for (const name of [
          "__openclawHostRequest",
          "__openclawHostCancelRequest",
          "__openclawHostTakeBridgeReply",
          "__openclawHostObserveNetworkContent",
        ]) {
          vm.newFunction(name, () => vm.undefined).consume((handle) =>
            vm.global.setProp(name, handle),
          );
        }
        for (const [name, value] of entries) {
          vm.hostToHandle(value).consume((handle) => vm.global.setProp(name, handle));
        }
        phase(`quickjs-${mode}/input`, at);
        at = performance.now();
        (mode === "source"
          ? vm.evalCode(CODE_MODE_CONTROLLER_SOURCE, "controller.js")
          : vm.evalBytecode(controllerBytecode)
        ).dispose();
        phase(`quickjs-${mode}/controller`, at);
        assert.equal(
          vm.evalCode("6 * 7").consume((handle) => handle.toNumber()),
          42,
        );
      } finally {
        vm.dispose();
      }
    }
  }
}

const cpuRows = [];
for (const count of [100_000, 1_000_000]) {
  const source = `(()=>{let x=0;for(let i=0;i<${count};i++)x=(x+i)|0;return x;})()`;
  const expected = count === 100_000 ? 704982704 : 1783293664;
  const script = new Script(source);
  const context = createContext(Object.create(null));
  for (const interruptMode of ["none", "deadline", "counted-deadline"] as const) {
    let interruptCalls = 0;
    const deadline = performance.now() + 120_000;
    const vm = await QuickJS.create({
      ...options,
      ...(interruptMode !== "none"
        ? {
            interruptHandler:
              interruptMode === "deadline"
                ? () => performance.now() >= deadline
                : () => {
                    interruptCalls++;
                    return performance.now() >= deadline;
                  },
          }
        : {}),
    });
    const nodeTimes: number[] = [],
      quickjsTimes: number[] = [];
    try {
      const bytecode = vm.compile(source);
      for (let index = -3; index < rounds; index++) {
        let at = performance.now();
        assert.equal(script.runInContext(context), expected);
        if (index >= 0) {
          nodeTimes.push(performance.now() - at);
        }
        at = performance.now();
        assert.equal(
          vm.evalBytecode(bytecode).consume((handle) => handle.toNumber()),
          expected,
        );
        if (index >= 0) {
          quickjsTimes.push(performance.now() - at);
        }
      }
      cpuRows.push({
        count,
        interruptMode,
        interruptCallsIncludingCompileAndWarmup:
          interruptMode === "counted-deadline" ? interruptCalls : undefined,
        node: summary(nodeTimes),
        quickjs: summary(quickjsTimes),
      });
    } finally {
      vm.dispose();
    }
  }
}

const snapshotRows = [];
for (const bytes of [0, 1024 * 1024, 8 * 1024 * 1024]) {
  const snapshotTimes: number[] = [],
    restoreTimes: number[] = [];
  let snapshotBytes = 0,
    guestBytes = 0;
  for (let index = -3; index < rounds; index++) {
    const vm = await QuickJS.create(options);
    try {
      vm.evalCode(
        `globalThis.retained = new Uint8Array(${bytes}); retained.fill(7); globalThis.pending = new Promise(()=>{});`,
      ).dispose();
      guestBytes = vm.getMemoryUsage().memoryUsedSize;
      let at = performance.now();
      const snapshot = vm.snapshot();
      if (index >= 0) {
        snapshotTimes.push(performance.now() - at);
      }
      snapshotBytes = snapshot.memory.byteLength;
      vm.dispose();
      at = performance.now();
      const restored = await QuickJS.restore(snapshot, options);
      if (index >= 0) {
        restoreTimes.push(performance.now() - at);
      }
      try {
        assert.equal(
          restored
            .evalCode("retained.length ? retained[0] + retained[retained.length - 1] : 0")
            .consume((handle) => handle.toNumber()),
          bytes ? 14 : 0,
        );
      } finally {
        restored.dispose();
      }
    } finally {
      vm.dispose();
    }
  }
  snapshotRows.push({
    bytes,
    snapshotBytes,
    guestBytes,
    snapshot: summary(snapshotTimes),
    restore: summary(restoreTimes),
  });
}

// Bounded dependency diagnostics, distinct from the production Code Mode path.
const deferredVm = await QuickJS.create(options);
const deferredBefore = deferredVm.getMemoryUsage().memoryUsedSize;
for (let index = 0; index < 32; index++) {
  const deferred = deferredVm.newPromise();
  const payload = deferredVm.evalCode("new Uint8Array(64 * 1024)");
  deferred.resolve(payload);
  payload.dispose();
  deferred.handle.dispose();
  deferredVm.executePendingJobs();
}
deferredVm.runGC();
const deferredAfter = deferredVm.getMemoryUsage().memoryUsedSize;
deferredVm.dispose();
const rejectionRows = [];
for (const length of [1000, 16_000, 64_000]) {
  const vm = await QuickJS.create(options);
  try {
    const rejected = vm.evalCode(`(async()=>{throw new Array(${length});})()`);
    vm.executePendingJobs();
    const result = await vm.resolvePromise(rejected);
    assert("error" in result);
    const beforeHeapBytes = process.memoryUsage().heapUsed;
    const at = performance.now();
    const dumped = vm.dump(result.error);
    const dumpMs = performance.now() - at;
    assert(Array.isArray(dumped));
    assert.equal(dumped.length, length);
    rejectionRows.push({
      length,
      dumpMs,
      hostElements: Object.keys(dumped).length,
      hostHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeapBytes,
    });
    result.error.dispose();
    rejected.dispose();
  } finally {
    vm.dispose();
  }
}
console.log(
  JSON.stringify({
    version,
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    rounds,
    compileMs,
    nativeControllerCompileMs,
    controllerBytecodeCompileMs,
    wasmBytes: wasmBytes.length,
    wasmSha256: sha256(wasmBytes),
    encodingSha256: sha256(encodingBytes),
    controllerSha256: sha256(CODE_MODE_CONTROLLER_SOURCE),
    benchmarkSha256: sha256(readFileSync(new URL(import.meta.url))),
    phases: Object.fromEntries(
      Object.entries(samples).map(([name, values]) => [name, summary(values)]),
    ),
    cpuRows,
    snapshotRows,
    deferredRetention: {
      beforeBytes: deferredBefore,
      afterBytes: deferredAfter,
      deltaBytes: deferredAfter - deferredBefore,
    },
    rejectionRows,
    loadStart,
    loadEnd: loadavg(),
    rssBytes: process.memoryUsage().rss,
  }),
);
