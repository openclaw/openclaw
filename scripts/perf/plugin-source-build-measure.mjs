// Node 26.12+: --expose-gc --import <repo>/scripts/tsx.mjs <this script>
// --repo <pinned checkout> --fixture <new synthetic subdirectory> --label A --samples 5
// First invocation adds --create. Alternate base/base controls and base/candidate runs.
// Acceptance: compiler mutations become zero; investigate >20% timing/CPU/allocation
// regression against A/A spread. Includes preparation cost; unrelated Team-scale rows
// and files beside this fixture are not scanned. Wrap each process with /usr/bin/time -l
// for child CPU; Node metrics cover its process/threads and main-isolate V8 allocation.
// --audit-fs records filesystem work separately from uninstrumented timing proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    fixture: { type: "string" },
    label: { type: "string" },
    samples: { type: "string", default: "5" },
    create: { type: "boolean" },
    "source-bytes": { type: "string", default: "65536" },
    "expect-no-mutations": { type: "boolean" },
    "audit-fs": { type: "boolean" },
  },
});
assert(values.repo && values.fixture && values.label && global.gc);
assert(
  !values["expect-no-mutations"] || values["audit-fs"],
  "Mutation acceptance requires --audit-fs",
);
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Node 26.12+ required");
const repo = path.resolve(values.repo);
const fixture = path.resolve(values.fixture);
const samples = Number(values.samples);
const sourceBytes = Number(values["source-bytes"]);
assert(Number.isInteger(sourceBytes) && sourceBytes >= 128);
assert(Number.isInteger(samples) && samples >= 1 && samples <= 100);
if (values.create) {
  fs.mkdirSync(fixture, { mode: 0o700 });
  fs.mkdirSync(path.join(fixture, "source"));
  fs.writeFileSync(path.join(fixture, "source/package.json"), '{"type":"commonjs"}');
  for (let index = 0; index < 200; index++) {
    const prefix = `const value: number = ${index}; exports.value = value;\n/*`;
    fs.writeFileSync(
      path.join(fixture, `source/module-${index}.ts`),
      prefix + ".".repeat(sourceBytes - Buffer.byteLength(prefix) - 3) + "*/\n",
    );
  }
}
const moduleUrl = (name) => pathToFileURL(path.join(repo, `src/${name}.ts`)).href;
const { preparePluginGenerationArtifact } = await import(
  moduleUrl("plugins/plugin-generation-worker")
);
const { buildPluginTypeScriptSource } = await import(moduleUrl("plugins/plugin-source-build"));
const { withPluginSourceCaptureStorage } = await import(
  moduleUrl("plugins/plugin-source-capture-context")
);
const { withArtifactPreservingStateReads } = await import(
  moduleUrl("state/artifact-preserving-state-reads")
);
const { observeMainThreadFs } = await import(
  moduleUrl("test-utils/main-thread-fs-spies.test-support")
);
const { closeDefaultRetainedNativeWorkerSource } = await import(
  moduleUrl("infra/worker-native-lifecycle")
);
const sources = Array.from({ length: 20 }, (_, index) =>
  path.join(fixture, `source/module-${index}.ts`),
);
const require = createRequire(import.meta.url);
const mutations = /^(?:mkdtemp|mkdir|writeFile|rename|unlink|rm|copyFile|symlink|link)Sync$/;
const hash = createHash("sha256");
const pluginFiles = [
  "plugin-source-build",
  "plugin-generation-capture",
  "plugin-generation-file-capture",
  "plugin-generation-source-lookup",
  "plugin-generation-frozen-source",
  "plugin-generation-artifact.types",
  "plugin-instance-module-loader",
  "plugin-generation-worker",
  "plugin-generation-preparation.worker",
  "plugin-generation-native-roots",
  "plugin-capture-native-resource",
  "plugin-capture-native-resource.client",
  "plugin-capture-native-resource.types",
  "plugin-native-admission-state",
  "plugin-native-admission",
  "plugin-generation-receipt",
  "plugin-source-file",
  "plugin-recovery-source-copy",
  "plugin-module-loader-recovery",
  "plugin-source-capture-directory",
];
for (const file of [
  ...pluginFiles.map((name) => `plugins/${name}`),
  "infra/worker-native-lifecycle",
  "infra/runtime-process-manifest",
  "process/spawn-broker/host",
  "process/spawn-broker/resource-authority",
  "process/spawn-broker/resource-server",
]) {
  const filename = path.join(repo, `src/${file}.ts`);
  hash.update(file);
  hash.update(fs.existsSync(filename) ? fs.readFileSync(filename) : "<absent>");
}
console.log(
  JSON.stringify({
    type: "metadata",
    label: values.label,
    repo,
    sourceHash: hash.digest("hex"),
    node: process.version,
    fixture,
    knownTypedFiles: 200,
    fixtureSourceUtf8Bytes: Array.from(
      { length: 200 },
      (_, index) => fs.statSync(path.join(fixture, `source/module-${index}.ts`)).size,
    ).reduce((sum, size) => sum + size, 0),
    executedTypedFiles: sources.length,
    hostLoad: loadavg(),
  }),
);
try {
  for (let sample = -1; sample < samples; sample++) {
    global.gc();
    const allocated = getHeapStatistics().total_allocated_bytes;
    const initialHeap = getHeapStatistics().used_heap_size;
    const cpu = process.cpuUsage();
    const threadCpu = process.threadCpuUsage();
    const start = performance.now();
    const preparationGuard = values["audit-fs"] ? observeMainThreadFs() : undefined;
    const prepared = await withArtifactPreservingStateReads(() =>
      withPluginSourceCaptureStorage(
        { stateDir: path.join(fixture, "state"), placement: "state" },
        () =>
          preparePluginGenerationArtifact({
            rootDir: path.join(fixture, "source"),
            source: sources,
          }),
      ),
    ).finally(() => preparationGuard?.[Symbol.dispose]());
    const preparedAt = performance.now();
    const preparedHeap = getHeapStatistics().used_heap_size;
    const artifact = prepared.artifact;
    const guard = values["audit-fs"] ? observeMainThreadFs() : undefined;
    const build = buildPluginTypeScriptSource(
      artifact.rootDir,
      artifact.executionAlias,
      artifact.sourceText,
    );
    try {
      for (const [index, source] of sources.entries()) {
        const target = build.resolve(artifact.resolve(source), "native", "commonjs");
        assert(fs.existsSync(require.resolve(target)), "Resolve-only path must exist");
        assert.equal(require(target).value, index);
      }
    } finally {
      build.dispose();
      guard?.[Symbol.dispose]();
    }
    const compiledAt = performance.now();
    const compilerMutations =
      guard &&
      Object.fromEntries(Object.entries(guard.calls()).filter(([name]) => mutations.test(name)));
    if (values["expect-no-mutations"]) {
      assert.deepEqual(compilerMutations, {});
    }
    const retirementGuard = values["audit-fs"] ? observeMainThreadFs() : undefined;
    await artifact.disposeAsync().finally(() => retirementGuard?.[Symbol.dispose]());
    const ended = performance.now();
    const processCpu = process.cpuUsage(cpu);
    const mainCpu = process.threadCpuUsage(threadCpu);
    console.log(
      JSON.stringify({
        type: sample < 0 ? "warmup" : "sample",
        label: values.label,
        sample,
        prepareMs: preparedAt - start,
        compileMs: compiledAt - preparedAt,
        retireMs: ended - compiledAt,
        elapsedMs: ended - start,
        processCpuMs: (processCpu.user + processCpu.system) / 1000,
        mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
        mainAllocatedBytes: getHeapStatistics().total_allocated_bytes - allocated,
        preparedHeapDeltaBytes: preparedHeap - initialHeap,
        preparedExecutionAliases: artifact.executionAliases?.size ?? 0,
        retainedExecutionSourceUtf8Bytes: [...(artifact.executionSources?.values() ?? [])].reduce(
          (sum, source) => sum + Buffer.byteLength(source),
          0,
        ),
        compilerMutations,
        compilerFsCalls: guard?.calls(),
        ...(values["audit-fs"]
          ? {
              preparationFsCalls: preparationGuard.calls(),
              compilerFsStacks: guard.stacks(),
              preparationFsStacks: preparationGuard.stacks(),
              retirementFsCalls: retirementGuard.calls(),
              retirementFsStacks: retirementGuard.stacks(),
            }
          : {}),
      }),
    );
  }
} finally {
  await closeDefaultRetainedNativeWorkerSource();
}
