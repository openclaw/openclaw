/**
 * Session row model-facts owner benchmark over 2,000 synthetic rows.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-harness-availability-measure.ts timing
 * Also run "counts" and "allocation" in separate processes. An optional source
 * directory overlays repo-relative files from the pinned baseline.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const [mode = "timing", baselineDir] = process.argv.slice(2);
assert(mode === "timing" || mode === "counts" || mode === "allocation");
assert(global.gc, "run with --expose-gc");
const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-harness-projection-"));
const sourceRoot = fileURLToPath(new URL("../..", import.meta.url));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_CODEX_APP_SERVER_BIN = "";
const platforms = { darwin: "apple-darwin", linux: "unknown-linux-musl", win32: "pc-windows-msvc" };
const platform = platforms[process.platform as keyof typeof platforms];
assert(
  platform && (process.arch === "arm64" || process.arch === "x64"),
  "unsupported fixture platform",
);
const arch = process.arch === "x64" ? "x86_64" : "aarch64";
const packageRoot = path.join(root, "node_modules", "@openai", "codex");
const launcher = path.join(packageRoot, "bin", "codex.js");
const native = path.join(
  packageRoot,
  "vendor",
  `${arch}-${platform}`,
  "bin",
  process.platform === "win32" ? "codex.exe" : "codex",
);
for (const file of [launcher, native]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "synthetic fixture", { mode: 0o755 });
}
fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"@openai/codex"}');
process.env.PATH = root;

const counts = {
  decisions: 0,
  auto: 0,
  pluginFrames: 0,
  supportFrames: 0,
  probes: 0,
  fsPathCalls: 0,
};
const counters = new Map<string, readonly [string, keyof typeof counts]>([
  [
    "src/agents/harness/availability.ts",
    ["const configured = resolveAgentHarnessPolicy", "decisions"],
  ],
  ["src/agents/harness/support.ts", ["const hintedCandidates = harnesses.map", "auto"]],
  [
    "src/plugins/plugin-instance-invocation.ts",
    ["return runWithAsyncStore(frames, frame, run);", "pluginFrames"],
  ],
  [
    "extensions/codex/src/app-server/managed-binary.ts",
    ["export function hasManagedCodexAppServerBinary(): boolean {", "probes"],
  ],
]);
Reflect.set(globalThis, "harnessBenchmarkCounts", counts);
const loader = registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:")) {
      return nextLoad(url, context);
    }
    const relative = path.relative(sourceRoot, fileURLToPath(url));
    if (relative.startsWith("..") || relative.includes("node_modules")) {
      return nextLoad(url, context);
    }
    const baseline = baselineDir && path.resolve(baselineDir, relative);
    const overlay = baseline && fs.existsSync(baseline) ? baseline : undefined;
    const counter = mode === "counts" ? counters.get(relative) : undefined;
    if (!overlay && !counter) {
      return nextLoad(url, context);
    }
    let source = fs.readFileSync(overlay ?? fileURLToPath(url), "utf8");
    if (counter) {
      const [marker, key] = counter;
      const increment = `Reflect.get(globalThis, "harnessBenchmarkCounts").${key} += ${key === "pluginFrames" ? "Number(frame.invocation !== undefined)" : "1"};\n`;
      assert(source.includes(marker), marker);
      source = source.replace(
        marker,
        marker.endsWith("{") ? marker + increment : increment + marker,
      );
    }
    return { format: "module-typescript", source, shortCircuit: true };
  },
});

if (mode === "counts") {
  for (const name of [
    "existsSync",
    "statSync",
    "lstatSync",
    "accessSync",
    "realpathSync",
    "openSync",
  ] as const) {
    const original = fs[name];
    Reflect.set(
      fs,
      name,
      new Proxy(original, {
        apply(target, receiver, args) {
          if (typeof args[0] === "string" && args[0].includes(packageRoot)) {
            counts.fsPathCalls++;
          }
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  }
  syncBuiltinESMExports();
}

try {
  const [
    { createCodexAppServerAgentHarness },
    { setManagedCodexPluginRoot },
    { createPluginRegistry },
    { createUnavailableRuntime },
    { getPluginInstance },
    { createPluginRecord },
    { getPluginRuntimeGatewayRequestScope },
    { readSessionRowModelFacts },
    { createSessionRuntimeResolution },
    { buildSessionListRowMetadataContext },
    { pluginInstanceInvocation },
    { setActivePluginRegistry },
    { buildSubagentSessionListReadIndex },
  ] = await Promise.all([
    import("../../extensions/codex/harness.js"),
    import("../../extensions/codex/src/app-server/managed-binary.js"),
    import("../../src/plugins/registry.js"),
    import("../../src/plugins/api-builder.js"),
    import("../../src/plugins/plugin-instance-scope.js"),
    import("../../src/plugins/status.test-helpers.js"),
    import("../../src/plugins/runtime/gateway-request-scope.js"),
    import("../../src/gateway/session-row-model-facts.js"),
    import("../../src/gateway/session-runtime-resolution.js"),
    import("../../src/gateway/session-utils-projection.js"),
    import("../../src/plugins/plugin-instance-invocation.js"),
    import("../../src/plugins/runtime.js"),
    import("../../src/agents/subagents/registry/subagent-registry-read.js"),
  ]);
  const builder = createPluginRegistry({
    runtime: createUnavailableRuntime("setup-only", "harness-projection-benchmark"),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const registry = builder.registry;
  const pluginRoot = path.join(sourceRoot, "extensions", "codex");
  const record = createPluginRecord({
    id: "codex",
    origin: "bundled",
    rootDir: pluginRoot,
    source: path.join(pluginRoot, "index.ts"),
  });
  registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const instance = getPluginInstance(record);
  assert(instance);
  setActivePluginRegistry(registry);
  setManagedCodexPluginRoot(root);
  const activationStart = performance.now();
  const harness = createCodexAppServerAgentHarness({
    get bindingStore(): never {
      throw new Error("Projection must not acquire native session state");
    },
  });
  const supports = harness.supports.bind(harness);
  if (mode === "counts") {
    harness.supports = (context) => {
      assert.equal(pluginInstanceInvocation.getStore()?.instance, instance);
      assert.equal(getPluginRuntimeGatewayRequestScope()?.pluginRegistry, registry);
      counts.supportFrames++;
      return supports(context);
    };
  }
  api.registerAgentHarness(harness);
  assert(registry.agentHarnesses.length === 1);
  const activation = { wallMs: performance.now() - activationStart, ...counts };
  assert(supports({ provider: "codex", requestedRuntime: "codex" }).supported);
  const modelCatalog: ModelCatalogEntry[] = [
    {
      provider: "openai",
      id: "gpt-test-2",
      name: "Fixture Responses",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    },
    { provider: "codex", id: "gpt-test-1", name: "Fixture native", api: "openai-responses" },
  ];
  const cfg: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-test" } },
    models: { providers: {} },
  };
  const now = 1_700_000_000_000;
  const rows = Array.from({ length: 2_000 }, (_, index) => {
    const agentId = `fixture-${Math.floor(index / 16) % 4}`;
    const provider = index % 2 === 0 ? "openai" : "codex";
    const model = `gpt-test-${index % 4 === 0 ? index : index % 5}`;
    const entry: SessionEntry = {
      sessionId: `session-${index}`,
      updatedAt: now - index,
      providerOverride: provider,
      modelOverride: model,
      ...(provider === "openai" ? { agentRuntimeOverride: "codex" } : {}),
    };
    return {
      agentId,
      key: `agent:${agentId}:bench-${index}`,
      entry,
      source: { entry, readSourceEntry: () => undefined },
    };
  });

  function projectRows() {
    const rowContext = buildSessionListRowMetadataContext({
      now,
      subagentRuns: buildSubagentSessionListReadIndex(now, [], new Map()),
    });
    return Array.from({ length: 125 }, (_, index) => {
      const runtimeResolution = createSessionRuntimeResolution(cfg);
      return rows.slice(index * 16, (index + 1) * 16).map((row) => {
        const { thinkingProjection } = readSessionRowModelFacts({
          ...row,
          cfg,
          rowContext,
          preparedModelMetadata: null,
          lightweightListRow: true,
          modelCatalog,
          runtimeResolution,
        });
        return [
          thinkingProjection.agentRuntime,
          thinkingProjection.capacityRuntime,
          thinkingProjection.thinkingLevels,
        ];
      });
    });
  }

  const warmup = projectRows();
  assert(
    warmup.some((batch) => batch.some((row) => row[1] === "codex")),
    "expected Codex rows",
  );
  global.gc();
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    counts[key] = 0;
  }
  const inspector = new Session();
  if (mode === "allocation") {
    await startCollectedHeapSampling(inspector, 4_096);
  }
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const result = projectRows();
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const allocation =
    mode === "allocation"
      ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
      : undefined;
  inspector.disconnect();
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex");
  console.log(
    JSON.stringify({
      mode,
      wallMs,
      cpuMs: (cpu.user + cpu.system) / 1_000,
      allocation,
      digest,
      activation,
      ...(mode === "counts" ? { counts } : {}),
      load: loadavg(),
    }),
  );
  await instance.dispose();
} finally {
  loader.deregister();
  fs.rmSync(root, { recursive: true, force: true });
}
