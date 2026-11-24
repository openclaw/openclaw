// Build each pinned checkout with pnpm build sourcePerformance first.
// Node26.12+: node --expose-gc <this script>
// --repo <pinned checkout> --fixture <owned synthetic directory> --label A1-0
// Serial A1/A2/A/B x5 processes. Each process measures cold and warm capture separately.
// Wrap with /usr/bin/time -l for whole process-tree CPU (includes imports and fixture setup).
// Recovery: --operation recovery [--fault recovery]. Measures the exported per-record owner
// on a real loaded plugin; the Gateway wrapper is exercised by its integration regression.
// Separate fault arms: --fault source|native --delay-ms 2000 [--expect-off-main].
// The preload holds a successful mkdtempSync return, before the owner receives its result;
// this is synthetic filesystem completion latency on APFS, not a btrfs measurement.
// Acceptance: exact root-create work moves off MAIN, capture/native lifetime and cleanup hold,
// fault-interval heartbeat remains responsive. Report every CPU/allocation/tail regression;
// >20% requires owner acceptance. Surrounding Team-shaped DB/workspace files are not scanned.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { installCaptureCreateProbe } from "./plugin-capture-custody-preload.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    fixture: { type: "string" },
    label: { type: "string" },
    fault: { type: "string" },
    operation: { type: "string", default: "capture" },
    "delay-ms": { type: "string", default: "2000" },
    "expect-off-main": { type: "boolean" },
  },
});
assert(values.repo && values.fixture && values.label && global.gc);
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Node26.12+ required");
assert(["capture", "recovery"].includes(values.operation));
assert(
  !values.fault ||
    (values.operation === "recovery"
      ? values.fault === "recovery"
      : ["source", "native"].includes(values.fault)),
);
const repo = path.resolve(values.repo);
const fixtureRoot = path.resolve(values.fixture);
const stateDir = path.join(fixtureRoot, `state-${values.label}`);
fs.mkdirSync(fixtureRoot, { recursive: true });
assert(!fs.existsSync(stateDir), "Each process requires a fresh task-owned state directory");
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "absent-config.json");
assert(![...process.execArgv, process.env.NODE_OPTIONS ?? ""].some((arg) => arg.includes("tsx")));
const dist = path.join(repo, "dist");
const builtModules = {};
// Match explicit exports, as in state-read-boot-bench; never infer hashed aliases.
async function built(prefix, names) {
  const result = {};
  for (const file of fs
    .readdirSync(dist)
    .filter((entry) => entry.startsWith(`${prefix}-`) && entry.endsWith(".mjs"))
    .toSorted()) {
    const source = fs.readFileSync(path.join(dist, file), "utf8");
    for (const block of source.matchAll(/export\s*\{([^}]+)\};/g)) {
      const exported = block[1].split(",").map((part) => part.trim());
      for (const name of names) {
        const selected = exported.find((part) => part === name || part.startsWith(`${name} as `));
        if (!selected) {
          continue;
        }
        const alias = selected.split(/\s+as\s+/)[1] ?? name;
        const value = (await import(pathToFileURL(path.join(dist, file)).href))[alias];
        assert.equal(typeof value, "function", `${file}: ${name}`);
        assert(!result[name] || result[name] === value, `Ambiguous built owner ${name}`);
        result[name] = value;
        builtModules[name] = { file, sha256: createHash("sha256").update(source).digest("hex") };
      }
    }
  }
  for (const name of names) {
    assert(result[name], `Missing built export ${name}`);
  }
  return result;
}
const faultArm =
  values.operation === "recovery" ? path.join(stateDir, ".recovery-probe-armed") : undefined;
let mainProbes = [];
if (values.fault) {
  const preload = new URL("./plugin-capture-custody-preload.mjs", import.meta.url);
  preload.searchParams.set("kind", values.fault);
  preload.searchParams.set("delayMs", values["delay-ms"]);
  if (faultArm) {
    preload.searchParams.set("armPath", faultArm);
  }
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import=${preload.href}`.trim();
  mainProbes = installCaptureCreateProbe(values.fault, Number(values["delay-ms"]), faultArm);
}
// The existing admission fixture helper generates these synthetic facts before the campaign.
const { fixture, nativeSize } = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8"),
);
const fixtureBytes = fs.readFileSync(fixture.filename);
const { preparePluginGenerationArtifact } = await built("plugin-generation-worker", [
  "preparePluginGenerationArtifact",
]);
const { preparePluginNativeAdmissions } = await built("plugin-native-admission-state", [
  "preparePluginNativeAdmissions",
]);
const { createPluginCache, retirePluginCache, withPluginCache } = await built("plugin-cache", [
  "createPluginCache",
  "retirePluginCache",
  "withPluginCache",
]);
const { resolvePluginInstallRoots, withPluginInstallRoots } = await built("install-root-context", [
  "resolvePluginInstallRoots",
  "withPluginInstallRoots",
]);
const { withPluginSourceCaptureStorage } = await built("plugin-source-capture-context", [
  "withPluginSourceCaptureStorage",
]);
const { withArtifactPreservingStateReads } = await built("artifact-preserving-state-reads", [
  "withArtifactPreservingStateReads",
]);
const { closeDefaultRetainedNativeWorkerSource, captureRetainedNativeWorkerSource } = await built(
  "worker-native-lifecycle",
  ["closeDefaultRetainedNativeWorkerSource", "captureRetainedNativeWorkerSource"],
);
// Native Node stripping loads only the shared observation tool, never production owners.
const { observeMainThreadFs } = await import(
  pathToFileURL(path.join(repo, "src/test-utils/main-thread-fs-spies.test-support.ts"))
);
const counters = () => ({
  allocated: getHeapStatistics().total_allocated_bytes,
  process: process.cpuUsage(),
  main: process.threadCpuUsage(),
});
const difference = (before, after) => ({
  processCpuMs:
    (after.process.user + after.process.system - before.process.user - before.process.system) /
    1000,
  mainCpuMs: (after.main.user + after.main.system - before.main.user - before.main.system) / 1000,
  mainAllocatedBytes: after.allocated - before.allocated,
});
const hash = createHash("sha256");
for (const name of [
  "plugins/plugin-generation-source-lookup",
  "plugins/plugin-recovery-source-copy",
  "plugins/plugin-package-metadata-capture",
  "plugins/plugin-source-capture-context",
  "plugins/plugin-generation-worker",
  "plugins/plugin-generation-preparation-pool",
  "plugins/plugin-generation-preparation.worker",
  "plugins/plugin-generation-native-roots",
  "plugins/plugin-source-capture-directory",
  "plugins/plugin-capture-native-resource",
  "plugins/plugin-capture-native-resource.client",
  "plugins/plugin-capture-native-resource.types",
  "plugins/plugin-native-admission-state",
  "infra/worker-native-lifecycle",
  "infra/runtime-process-manifest",
  "process/spawn-broker/resource-authority",
  "process/spawn-broker/resource-server",
]) {
  const filename = path.join(repo, `src/${name}.ts`);
  hash.update(name).update(fs.existsSync(filename) ? fs.readFileSync(filename) : "<absent>");
}
console.log(
  JSON.stringify({
    type: "metadata",
    label: values.label,
    repo,
    sourceHash: hash.digest("hex"),
    runtimeRoute: "built-js",
    builtModules,
    node: process.version,
    pid: process.pid,
    nativeBytes: nativeSize,
    fixtureRoot,
    hostLoad: loadavg(),
    fault: values.fault ?? null,
    operation: values.operation,
  }),
);
const childProbes = [];
const childRoutes = [];
const observeChild = ({ process: child }) => {
  let pending = "";
  // Node publishes child_process from the constructor, before assigning stdio.
  child.once("spawn", () => {
    const argv = child.spawnargs;
    assert(
      !argv.some((arg) => arg.includes("tsx") || /\.[cm]?ts(?:\?|$)/u.test(arg)),
      "Production child must use built JavaScript",
    );
    childRoutes.push({ pid: child.pid, argv });
    child.stderr?.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith("CAPTURE_CREATE_PROBE ")) {
          childProbes.push(JSON.parse(line.slice(21)));
        }
      }
    });
  });
};
// The Gateway integration regression exercises createPluginReloadRecovery. Its
// bundled wrapper is private; this workload calls its exported per-record owner.
async function measureRecovery() {
  const { loadOpenClawPluginsAsync } = await built("loader-runtime-load", [
    "loadOpenClawPluginsAsync",
  ]);
  const { capturePluginRuntimeRecovery } = await built("plugin-runtime-artifact-binding", [
    "capturePluginRuntimeRecovery",
  ]);
  const plugin = path.join(stateDir, "serving-plugin");
  fs.cpSync(fixture.root, plugin, { recursive: true });
  const imports = [];
  const payloads = [];
  const companionCount = 199;
  const companionBytes = 8192;
  for (let index = 0; index < companionCount; index++) {
    const filename = `companion-${index}.js`;
    const payload = `synthetic-recovery-${index}:`.padEnd(companionBytes, "x");
    fs.writeFileSync(
      path.join(plugin, filename),
      `export const payload = ${JSON.stringify(payload)};\n`,
    );
    imports.push(`import { payload as p${index} } from './${filename}';`);
    payloads.push(`p${index}`);
  }
  const expectedPayloadBytes = companionCount * companionBytes;
  fs.writeFileSync(
    path.join(plugin, "index.js"),
    `${imports.join("\n")}
export default { id: 'fixture', register(api) {
    api.registerProvider({ id: 'recovery-probe', label: 'Serving', auth: [],
      normalizeModelId: ({ modelId }) => 'serving:' + modelId + ':' +
        [${payloads.join(",")}].reduce((total, payload) => total + payload.length, 0) });
  } };\n`,
  );
  const expectedEntry = fs.readFileSync(path.join(plugin, "index.js"));
  const emptyBundled = path.join(stateDir, "empty-bundled");
  fs.mkdirSync(emptyBundled);
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundled;
  const captureParent = path.join(stateDir, "tmp", "plugin-captures");
  const captures = () =>
    fs
      .readdirSync(captureParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const directory = path.join(captureParent, entry.name, "captures");
        return fs.existsSync(directory)
          ? fs
              .readdirSync(directory)
              .filter((name) => name.startsWith("openclaw-plugin-build-"))
              .map((name) => path.join(directory, name))
          : [];
      })
      .toSorted();
  const cache = createPluginCache();
  const scoped = (run) =>
    withPluginCache(cache, () =>
      withPluginInstallRoots({ ...resolvePluginInstallRoots(), stateDir }, () =>
        withPluginSourceCaptureStorage({ stateDir, placement: "state" }, run),
      ),
    );
  let recovery;
  try {
    const serving = await scoped(() =>
      loadOpenClawPluginsAsync({
        activate: false,
        config: {
          plugins: { allow: ["fixture"], load: { paths: [plugin] }, slots: { memory: "none" } },
        },
      }),
    );
    const record = serving.plugins.find((item) => item.id === "fixture");
    assert.equal(record?.status, "loaded", record?.error);
    const provider = serving.providers.find(
      (item) => item.provider.id === "recovery-probe",
    ).provider;
    assert.equal(
      provider.normalizeModelId({ provider: "recovery-probe", modelId: "loaded" }),
      `serving:loaded:${expectedPayloadBytes}`,
    );
    const before = captures();
    for (const phase of values.fault ? ["cold"] : ["cold", "warm"]) {
      const beats = [];
      let previous = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        beats.push({ atMs: now, gapMs: now - previous });
        previous = now;
      }, 5);
      await delay(20);
      global.gc();
      if (values.fault) {
        fs.writeFileSync(faultArm, "synthetic recovery phase");
      }
      beats.length = 0;
      previous = Date.now();
      const guard = values.fault ? observeMainThreadFs() : undefined;
      const initialHeap = getHeapStatistics().used_heap_size;
      const captureCounters = counters();
      const started = performance.now();
      try {
        recovery = await scoped(() => capturePluginRuntimeRecovery(record));
        const capturedAt = performance.now();
        const captureUsage = difference(captureCounters, counters());
        const capturedHeapDeltaBytes = getHeapStatistics().used_heap_size - initialHeap;
        assert(recovery, "Serving record must yield actual recovery custody");
        const added = captures().filter((directory) => !before.includes(directory));
        assert.equal(added.length, 1, "Recovery must own a distinct source copy");
        const directories = [added[0]];
        let copiedEntry = false;
        let copiedFileCount = 0;
        let copiedFileBytes = 0;
        for (const directory of directories) {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              directories.push(filename);
            } else if (entry.isFile()) {
              copiedFileCount++;
              copiedFileBytes += fs.statSync(filename).size;
              if (entry.name === "index.js") {
                copiedEntry ||= fs.readFileSync(filename).equals(expectedEntry);
              }
            }
          }
        }
        assert(copiedEntry, "Recovery must retain the serving plugin's actual entry bytes");
        assert(copiedFileCount >= companionCount + 1);
        assert(copiedFileBytes >= expectedPayloadBytes);
        const disposeCounters = counters();
        const disposingAt = performance.now();
        await recovery.module.dispose();
        const disposedAt = performance.now();
        const disposeUsage = difference(disposeCounters, counters());
        guard?.[Symbol.dispose]();
        recovery = undefined;
        assert(!fs.existsSync(added[0]), "Recovery disposal must join physical cleanup");
        assert.deepEqual(captures(), before);
        assert.equal(
          provider.normalizeModelId({ provider: "recovery-probe", modelId: "live" }),
          `serving:live:${expectedPayloadBytes}`,
        );
        await delay(10);
        const probes = [...mainProbes, ...childProbes];
        const holds = probes.filter((probe) => probe.held);
        const calls = guard
          ?.stacks()
          .filter(({ stack }) =>
            /plugin-(generation-source-lookup|recovery-source-copy|package-metadata-capture|source-capture|native-reference)/u.test(
              stack,
            ),
          );
        const heldBeats = beats.filter((beat) =>
          holds.some(
            (hold) => beat.atMs >= hold.startedAtMs && beat.atMs - beat.gapMs <= hold.endedAtMs,
          ),
        );
        const faultHeartbeatMaxMs = holds.length
          ? Math.max(0, ...heldBeats.map((beat) => beat.gapMs))
          : null;
        if (values.fault) {
          assert.equal(holds.length, 1);
          assert.equal(holds[0].kind, "recovery");
          assert(holds[0].endedAtMs - holds[0].startedAtMs >= Number(values["delay-ms"]) - 10);
          assert.equal(holds[0].pid === process.pid, !values["expect-off-main"]);
          assert(heldBeats.length > 0, "Heartbeat must cover actual create delay");
          if (values["expect-off-main"]) {
            assert.deepEqual(calls, []);
            assert(faultHeartbeatMaxMs < 250, "MAIN must stay responsive during recovery create");
          } else {
            assert(calls.length > 0);
            assert(faultHeartbeatMaxMs >= Number(values["delay-ms"]) - 10);
          }
        }
        console.log(
          JSON.stringify({
            type: "sample",
            operation: "recovery",
            copiedFileCount,
            copiedFileBytes,
            label: values.label,
            phase,
            captureMs: capturedAt - started,
            disposeMs: disposedAt - disposingAt,
            ownerMs: capturedAt - started + disposedAt - disposingAt,
            captureUsage,
            disposeUsage,
            processCpuMs: captureUsage.processCpuMs + disposeUsage.processCpuMs,
            mainCpuMs: captureUsage.mainCpuMs + disposeUsage.mainCpuMs,
            mainAllocatedBytes: captureUsage.mainAllocatedBytes + disposeUsage.mainAllocatedBytes,
            capturedHeapDeltaBytes,
            heartbeatMaxMs: Math.max(0, ...beats.map((beat) => beat.gapMs)),
            heartbeatTicks: beats.length,
            faultHeartbeatMaxMs,
            probes,
            calls,
            childRoutes,
            builtModules,
            hostLoad: loadavg(),
          }),
        );
      } finally {
        clearInterval(timer);
        guard?.[Symbol.dispose]();
        await recovery?.module.dispose();
      }
    }
  } finally {
    await retirePluginCache(cache);
  }
}

const children = channel("child_process");
children.subscribe(observeChild);
try {
  if (values.operation === "recovery") {
    await measureRecovery();
  } else {
    for (const phase of values.fault ? ["cold"] : ["cold", "warm"]) {
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      const cache = createPluginCache();
      const beats = [];
      let previous = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        beats.push({ atMs: now, gapMs: now - previous });
        previous = now;
      }, 5);
      await delay(20);
      global.gc();
      beats.length = 0;
      previous = Date.now();
      const initialHeap = getHeapStatistics().used_heap_size;
      const preparationCounters = counters();
      const start = performance.now();
      const guard = values.fault ? observeMainThreadFs() : undefined;
      let prepared;
      try {
        prepared = await withArtifactPreservingStateReads(() =>
          withPluginCache(cache, () =>
            withPluginInstallRoots({ ...resolvePluginInstallRoots(), stateDir }, () =>
              withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () => {
                preparePluginNativeAdmissions(fixture.index, cache);
                return preparePluginGenerationArtifact({
                  rootDir: fixture.root,
                  source: fixture.entry,
                });
              }),
            ),
          ),
        );
        const preparedAt = performance.now();
        const preparationUsage = difference(preparationCounters, counters());
        const preparedHeapDeltaBytes = getHeapStatistics().used_heap_size - initialHeap;
        const workerRoutes = source.activeWorkerPaths();
        assert(workerRoutes.length > 0, "Real preparation must have an active worker");
        assert(
          workerRoutes.every(
            (route) => route && route.includes("/dist/") && /\.m?js$/u.test(route),
          ),
          "Production workers must use built JavaScript",
        );
        const capturedNative = fs.realpathSync(prepared.artifact.resolve(fixture.filename));
        assert.notEqual(capturedNative, fixture.filename);
        assert.equal(fs.statSync(capturedNative).size, nativeSize);
        assert.equal(fs.readFileSync(capturedNative).compare(fixtureBytes), 0);
        // Validation reads are outside both owner timing and owner CPU/allocation intervals.
        const retirementCounters = counters();
        const retiringAt = performance.now();
        await prepared.artifact.disposeAsync();
        const artifactClosedAt = performance.now();
        const closesSource = phase === "warm" || Boolean(values.fault);
        if (closesSource) {
          await closeDefaultRetainedNativeWorkerSource();
          assert(fs.existsSync(capturedNative), "Native lease must survive completed source close");
        }
        const sourceClosedAt = performance.now();
        await retirePluginCache(cache);
        const ended = performance.now();
        const retirementUsage = difference(retirementCounters, counters());
        guard?.[Symbol.dispose]();
        assert(
          !fs.existsSync(capturedNative),
          "Final native lease retirement must remove private bytes",
        );
        await delay(10);
        const probes = [...mainProbes, ...childProbes];
        const holds = probes.filter((probe) => probe.held);
        const rootCalls = guard
          ?.stacks()
          .filter(({ stack }) => stack.includes("plugin-source-capture-directory"));
        if (values.fault) {
          assert.equal(holds.length, 1, "Exactly one selected root create must be held");
          assert.equal(holds[0].kind, values.fault);
          assert(holds[0].endedAtMs - holds[0].startedAtMs >= Number(values["delay-ms"]) - 10);
          assert.equal(holds[0].pid === process.pid, !values["expect-off-main"]);
          for (const kind of ["source", "native"]) {
            assert.equal(
              probes.filter((probe) => probe.kind === kind).length,
              1,
              `One ${kind} root per capture`,
            );
          }
          if (values["expect-off-main"]) {
            assert.deepEqual(rootCalls, []);
          } else {
            assert(rootCalls.length > 0);
          }
        }
        const heldBeats = beats.filter((beat) =>
          holds.some(
            (hold) => beat.atMs >= hold.startedAtMs && beat.atMs - beat.gapMs <= hold.endedAtMs,
          ),
        );
        const faultHeartbeatMaxMs = holds.length
          ? Math.max(0, ...heldBeats.map((beat) => beat.gapMs))
          : null;
        if (values.fault) {
          assert(heldBeats.length > 0, "Heartbeat must cover the actual stalled create");
          if (values["expect-off-main"]) {
            assert(faultHeartbeatMaxMs < 250, "MAIN must remain responsive during broker create");
          } else {
            assert(
              faultHeartbeatMaxMs >= Number(values["delay-ms"]) - 10,
              "Baseline must expose the injected MAIN stall",
            );
          }
        }
        console.log(
          JSON.stringify({
            type: "sample",
            label: values.label,
            phase,
            prepareMs: preparedAt - start,
            artifactCloseMs: artifactClosedAt - retiringAt,
            sourceCloseMs: sourceClosedAt - artifactClosedAt,
            cacheRetireMs: ended - sourceClosedAt,
            retireMs: ended - retiringAt,
            ownerMs: preparedAt - start + ended - retiringAt,
            preparationUsage,
            retirementUsage,
            processCpuMs: preparationUsage.processCpuMs + retirementUsage.processCpuMs,
            mainCpuMs: preparationUsage.mainCpuMs + retirementUsage.mainCpuMs,
            mainAllocatedBytes:
              preparationUsage.mainAllocatedBytes + retirementUsage.mainAllocatedBytes,
            preparedHeapDeltaBytes,
            heartbeatMaxMs: Math.max(0, ...beats.map((beat) => beat.gapMs)),
            faultHeartbeatMaxMs,
            heartbeatTicks: beats.length,
            probes,
            rootCalls,
            workerRoutes,
            childRoutes,
            hostLoad: loadavg(),
          }),
        );
      } finally {
        clearInterval(timer);
        guard?.[Symbol.dispose]();
        await prepared?.artifact.disposeAsync();
        await retirePluginCache(cache);
      }
    }
  }
} finally {
  children.unsubscribe(observeChild);
  await closeDefaultRetainedNativeWorkerSource();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
