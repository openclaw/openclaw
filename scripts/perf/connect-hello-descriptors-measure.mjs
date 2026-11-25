/**
 * OPENCLAW_STATE_DIR=$PWD/.local/hello-owner node --import ./scripts/tsx.mjs --expose-gc \
 *   scripts/perf/connect-hello-descriptors-measure.mjs BASE_REF [CALLS=3000] [PAIRS=5] \
 *   [WORKLOAD=all|hello|descriptors|tabs|widgets|readers] [CANDIDATE_REF=WORKTREE]
 * Exact owner modules share unchanged dependencies; temporary modules are removed
 * on exit. Forty synthetic plugins advertise tabs, widgets, and link readers via
 * real registry/config/scope projection code. No built-in prototypes are modified.
 * Counterbalanced untraced CPU and separate inclusive allocation passes report
 * section bytes, host load, GC, RSS/heap, and source hashes as JSONL.
 * Wire equivalence/input preservation cover read/admin/no scopes and UI config
 * changes. These owner measurements do not establish full connect latency.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { setRuntimeConfigSnapshot } from "../../src/config/runtime-snapshot.js";
import { createGatewayMethodRegistry } from "../../src/gateway/methods/registry.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { sampledOwnerBytes } from "../lib/sampled-owner-allocation.mjs";

const [baseRef, callsArg = "3000", pairsArg = "5", selected = "all", candidateRef = "WORKTREE"] =
  process.argv.slice(2);
const calls = Number(callsArg),
  pairs = Number(pairsArg),
  samplingInterval = 4096;
assert(baseRef && globalThis.gc, "BASE_REF and --expose-gc are required");
assert([calls, pairs].every((n) => Number.isSafeInteger(n) && n > 0));
const output = (value) => console.log(JSON.stringify(value));
const temporaryFiles = [];
process.once("exit", () => temporaryFiles.forEach((file) => rmSync(file, { force: true })));
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
const file = "src/gateway/control-ui-plugin-tabs.ts";
const owners = {};
for (const side of ["base", "candidate"]) {
  const ref = side === "base" ? baseRef : candidateRef;
  const source =
    ref === "WORKTREE"
      ? readFileSync(file, "utf8")
      : execFileSync("git", ["show", `${ref}:${file}`], {
          encoding: "utf8",
          env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
        });
  const temporary = path.resolve(
    path.dirname(file),
    `.hello-descriptors-${process.pid}-${side}.ts`,
  );
  writeFileSync(temporary, source, { flag: "wx" });
  temporaryFiles.push(temporary);
  const url = pathToFileURL(temporary).href;
  owners[side] = {
    module: await import(url),
    url,
    hash: createHash("sha256").update(source).digest("hex"),
  };
}
const registry = createEmptyPluginRegistry();
const methodDescriptors = [];
for (let index = 39; index >= 0; index--) {
  const id = `synthetic-${String(index).padStart(2, "0")}`;
  registry.plugins.push({
    id,
    name: id,
    enabled: true,
    status: "loaded",
    origin: "global",
    controlUi: {},
  });
  for (const surface of ["tab", "widget", "link-reader"]) {
    registry.controlUiDescriptors.push({
      pluginId: id,
      pluginName: id,
      source: "synthetic",
      descriptor: {
        id: surface,
        surface,
        label: `${surface} ${id}`,
        requiredScopes: [index % 4 ? "operator.read" : "operator.admin"],
        ...(surface === "tab" ? { path: `/plugins/${id}`, slug: id, order: index % 3 } : {}),
        ...(surface === "link-reader"
          ? { linkReader: { hosts: [`${id}.example.test`], detailMethod: `${id}.detail` } }
          : {}),
      },
    });
  }
  registry.httpRoutes.push({
    pluginId: id,
    source: "synthetic",
    path: `/plugins/${id}`,
    match: "prefix",
    auth: "gateway",
    handler: async () => true,
  });
  methodDescriptors.push({
    name: `${id}.detail`,
    scope: "operator.read",
    owner: { kind: "plugin", pluginId: id },
    handler: async () => {},
  });
}
setActivePluginRegistry(registry);
const methods = createGatewayMethodRegistry(methodDescriptors, registry);
const inputSnapshot = () =>
  JSON.stringify([registry.plugins, registry.controlUiDescriptors, registry.httpRoutes]);
const initialInputs = inputSnapshot();
const workloads = {
  descriptors: (m, scopes) => m.listControlUiPluginDescriptors(scopes),
  tabs: (m, scopes) => m.listControlUiPluginTabs(scopes),
  widgets: (m, scopes) => m.listControlUiPluginWidgetKinds(scopes),
  readers: (m, scopes) => m.listControlUiLinkReaders(scopes, methods),
  hello: (m, scopes) => ({
    controlUiTabs: m.listControlUiPluginTabs(scopes),
    controlUiWidgetKinds: m.listControlUiPluginWidgetKinds(scopes),
    controlUiLinkReaders: m.listControlUiLinkReaders(scopes, methods),
  }),
};
assert(selected === "all" || Object.hasOwn(workloads, selected), "unknown workload");
output({
  protocol: "connect-hello-descriptors-v2",
  baseRef,
  candidateRef,
  calls,
  pairs,
  selected,
  samplingInterval,
  node: process.version,
  plugins: registry.plugins.length,
  hashes: Object.fromEntries(Object.entries(owners).map(([side, owner]) => [side, owner.hash])),
});
for (const customPlugins of [true, false]) {
  setRuntimeConfigSnapshot({
    gateway: {
      controlUi: { basePath: customPlugins ? "" : "/team", experimental: { customPlugins } },
    },
  });
  for (const scopes of [[], ["operator.read"], ["operator.admin"]]) {
    for (const [key, run] of Object.entries(workloads)) {
      const base = JSON.stringify(run(owners.base.module, scopes));
      assert.equal(JSON.stringify(run(owners.candidate.module, scopes)), base);
      output({
        proof: "wire-equivalence",
        workload: key,
        scopes,
        customPlugins,
        jsonBytes: Buffer.byteLength(base),
      });
    }
  }
}
assert.equal(inputSnapshot(), initialInputs);
setRuntimeConfigSnapshot({ gateway: { controlUi: { experimental: { customPlugins: true } } } });
const scopes = ["operator.admin"];
let checksum = 0,
  gcEntries = [];
const observer = new PerformanceObserver((list) => gcEntries.push(...list.getEntries()));
observer.observe({ entryTypes: ["gc"] });
try {
  for (const [key, run] of Object.entries(workloads)) {
    if (selected !== "all" && selected !== key) {
      continue;
    }
    for (const owner of Object.values(owners)) {
      for (let warm = 0; warm < 200; warm++) {
        run(owner.module, scopes);
      }
    }
    for (const mode of ["cpu", "allocation"]) {
      const inspector = mode === "allocation" ? new Session() : undefined;
      inspector?.connect();
      try {
        for (let pair = 0; pair < pairs; pair++) {
          for (const side of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
            globalThis.gc();
            await setImmediate();
            await setImmediate();
            gcEntries = [];
            if (inspector) {
              await inspector.post("HeapProfiler.startSampling", {
                samplingInterval,
                includeObjectsCollectedByMajorGC: true,
                includeObjectsCollectedByMinorGC: true,
              });
            }
            const hostLoad = loadavg(),
              cpu = process.cpuUsage(),
              thread = process.threadCpuUsage?.(),
              started = performance.now();
            for (let iteration = 0; iteration < calls; iteration++) {
              const result = run(owners[side].module, scopes);
              checksum += Array.isArray(result) ? result.length : result.controlUiTabs.length;
            }
            const ended = performance.now(),
              used = process.cpuUsage(cpu),
              threadUsed = thread && process.threadCpuUsage(thread),
              memory = process.memoryUsage();
            const allocation = inspector
              ? sampledOwnerBytes(
                  (await inspector.post("HeapProfiler.stopSampling")).profile,
                  owners[side].url,
                )
              : undefined;
            await setImmediate();
            await setImmediate();
            const pauses = gcEntries.filter(
              (entry) => entry.startTime >= started && entry.startTime < ended,
            );
            const gcByKind = {};
            for (const pause of pauses) {
              const kind = (gcByKind[pause.detail.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
              kind.count++;
              kind.totalMs += pause.duration;
              kind.maxMs = Math.max(kind.maxMs, pause.duration);
            }
            output({
              workload: key,
              mode,
              pair,
              side,
              calls,
              hostLoad,
              wallUsPerOp: ((ended - started) * 1000) / calls,
              processCpuUsPerOp: (used.user + used.system) / calls,
              threadCpuUsPerOp: threadUsed ? (threadUsed.user + threadUsed.system) / calls : null,
              gcMs: pauses.reduce((sum, pause) => sum + pause.duration, 0),
              gcCount: pauses.length,
              gcMaxMs: Math.max(0, ...pauses.map((pause) => pause.duration)),
              gcByKind,
              rssBytes: memory.rss,
              heapUsedBytes: memory.heapUsed,
              ...(allocation
                ? {
                    sampledBytesPerOp: allocation.bytes / calls,
                    allocationSamples: allocation.samples,
                  }
                : {}),
            });
          }
        }
      } finally {
        inspector?.disconnect();
      }
    }
  }
  assert.equal(inputSnapshot(), initialInputs);
  output({ proof: "inputs-preserved", checksum });
} finally {
  observer.disconnect();
}
