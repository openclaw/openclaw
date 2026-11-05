/**
 * Attribute the inclusive session-resource-loader checkpoint on synthetic state.
 * Seed with team-shape-fixture.ts; no production state or credentials are needed.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-resource-loader-measure.mjs \
 *   --root .local/fixture --workspace .local/workspace --owner context --mode timing --output result.json
 * Owners: loader (actual embedded factories), settings, context (bounded SQL owner).
 * Run timing/allocation separately; alternate identical A/A controls, then saved
 * baseline/candidate owners via --baseline (and --source for A/A). Imports,
 * warmup and GC are untimed. Both arms share the same fixture and dependencies.
 * context measures worker SQL on this thread, not Gateway latency or worker IPC.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    workspace: { type: "string" },
    owner: { type: "string", default: "context" },
    mode: { type: "string", default: "timing" },
    output: { type: "string" },
    source: { type: "string" },
    baseline: { type: "string" },
    samples: { type: "string", default: "5" },
    iterations: { type: "string" },
    "session-id": { type: "string" },
  },
});
assert(values.root && values.workspace && values.output && global.gc);
assert(["loader", "settings", "context"].includes(values.owner));
assert(["timing", "allocation", "counts", "profile"].includes(values.mode));
const root = path.resolve(values.root),
  cwd = path.resolve(values.workspace);
assert.equal(
  JSON.parse(fs.readFileSync(path.join(root, "team-shape-summary.json"), "utf8")).format,
  "openclaw-team-shape-v1",
);
const samples = Number(values.samples),
  iterations = Number(values.iterations ?? (values.owner === "context" ? "10" : "2000"));
assert(
  Number.isSafeInteger(samples) &&
    samples > 0 &&
    Number.isSafeInteger(iterations) &&
    iterations > 0,
);
assert(!fs.existsSync(values.output), "Refusing to overwrite a result");
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
});
const ownerUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-active-context.ts",
  import.meta.url,
);
const source = values.source ? pathToFileURL(path.resolve(values.source)) : ownerUrl;
const baselineUrl = new URL(ownerUrl);
baselineUrl.search = "comparison";
const baselineSource = values.baseline ? pathToFileURL(path.resolve(values.baseline)) : undefined;
let replaced = false;
let baselineReplaced = false;
if (values.source || baselineSource) {
  registerHooks({
    load(url, context, next) {
      if (baselineSource && url === baselineUrl.href) {
        baselineReplaced = true;
        const loaded = next(baselineSource.href, context);
        return { format: loaded.format, source: loaded.source, shortCircuit: true };
      }
      if (!values.source) {
        return next(url, context);
      }
      if (url !== ownerUrl.href) {
        return next(url, context);
      }
      replaced = true;
      const loaded = next(source.href, context);
      return { format: loaded.format, source: loaded.source, shortCircuit: true };
    },
  });
}
const { applyLoggingConfig } = await import("../../src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  consoleLevel: "silent",
  file: path.join(root, "measure.log"),
});
const agentDir = path.join(root, "agents/main/agent");
const config = {
  plugins: { enabled: false },
  agents: { defaults: { compaction: { mode: "safeguard" } } },
};
let run,
  baselineRun,
  close = async () => {},
  expectedDigest,
  selectedSession;
if (values.owner === "context") {
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.ts");
  const { readSessionTranscriptBoundedActiveContextCore } =
    await import("../../src/config/sessions/session-accessor.sqlite-active-context.ts");
  assert(!values.source || replaced, "Requested owner was not loaded");
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  selectedSession =
    values["session-id"] ??
    database.db
      .prepare(
        "SELECT session_id FROM transcript_event_identities GROUP BY session_id ORDER BY count(*) DESC LIMIT 1",
      )
      .get().session_id;
  assert(typeof selectedSession === "string");
  const target = {
    agentId: "main",
    sessionId: selectedSession,
    sessionKey: database.db
      .prepare("SELECT session_key FROM session_nodes WHERE current_session_id=?")
      .get(selectedSession).session_key,
    storePath: database.path,
  };
  run = () =>
    readSessionTranscriptBoundedActiveContextCore(target, { maxBytes: 1024000, maxEvents: 10000 });
  if (baselineSource) {
    const baseline = await import(baselineUrl.href);
    assert(baselineReplaced, "Comparison owner was not loaded");
    baselineRun = () =>
      baseline.readSessionTranscriptBoundedActiveContextCore(target, {
        maxBytes: 1024000,
        maxEvents: 10000,
      });
  }
  close = closeOpenClawAgentDatabasesAsync;
} else if (values.owner === "loader") {
  const { DefaultResourceLoader } = await import("../../src/agents/sessions/resource-loader.ts");
  const { buildEmbeddedExtensionFactories } =
    await import("../../src/agents/embedded-agent-runner/extensions.ts");
  const { SessionManager } = await import("../../src/agents/sessions/session-manager.ts");
  const manager = SessionManager.inMemory(cwd);
  run = async () => {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      extensionFactories: buildEmbeddedExtensionFactories({
        cfg: config,
        sessionManager: manager,
        workspaceDir: cwd,
        sessionId: "synthetic-resource-loader",
        model: undefined,
      }),
    });
    await loader.reload();
    assert.equal(loader.getExtensions().extensions.length, 2);
    assert.equal(loader.getExtensions().errors.length, 0);
    assert.equal(
      loader.getSkills().skills.length +
        loader.getPrompts().prompts.length +
        loader.getThemes().themes.length,
      0,
    );
  };
} else {
  const { createPreparedEmbeddedAgentSettingsManager } =
    await import("../../src/agents/agent-project-settings.ts");
  const { loadPluginMetadataSnapshot } =
    await import("../../src/plugins/plugin-metadata-snapshot.ts");
  const metadata = loadPluginMetadataSnapshot({ workspaceDir: cwd, config });
  run = () =>
    createPreparedEmbeddedAgentSettingsManager({
      sessionId: "synthetic-resource-loader",
      cwd,
      agentDir,
      cfg: config,
      pluginMetadataSnapshot: metadata,
      contextTokenBudget: 128000,
    });
}
const inspector = new Session();
inspector.connect();
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(value, (_key, item) => (item instanceof Map ? [...item] : item)))
    .digest("hex");
const sum = (node) => node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
const results = [],
  counts = {},
  restores = [];
try {
  const coldStart = performance.now();
  const first = await run();
  const coldMs = performance.now() - coldStart;
  if (values.owner === "context") {
    assert(
      first.events.length > 1 && first.totalEvents > 1,
      "Empty context is not a fixture proof",
    );
    expectedDigest = digest(first);
  }
  for (let i = 0; i < 5; i++) {
    await run();
  }
  if (baselineRun) {
    for (let i = 0; i < 5; i++) {
      assert.equal(digest(await baselineRun()), expectedDigest);
    }
  }
  if (values.mode === "counts") {
    for (const name of [
      "readFileSync",
      "readdirSync",
      "statSync",
      "lstatSync",
      "realpathSync",
      "existsSync",
      "openSync",
    ]) {
      const original = fs[name];
      restores.push(() => (fs[name] = original));
      fs[name] = function (...args) {
        counts[name] = (counts[name] ?? 0) + 1;
        return original.apply(this, args);
      };
    }
    const parse = JSON.parse;
    restores.push(() => (JSON.parse = parse));
    JSON.parse = function (...args) {
      counts.jsonParse = (counts.jsonParse ?? 0) + 1;
      return parse.apply(this, args);
    };
    syncBuiltinESMExports();
  }
  if (values.mode === "profile") {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  for (let sample = 0; sample < samples; sample++) {
    const arms = baselineRun ? (sample % 2 === 0 ? ["A", "B"] : ["B", "A"]) : ["B"];
    for (const arm of arms) {
      const operation = arm === "A" ? baselineRun : run;
      global.gc();
      if (values.mode === "allocation") {
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 32768,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
      }
      const cpu = process.cpuUsage(),
        thread = process.threadCpuUsage(),
        start = performance.now();
      let last;
      for (let i = 0; i < iterations; i++) {
        last = await operation();
      }
      const wallMs = performance.now() - start,
        processCpu = process.cpuUsage(cpu),
        threadCpu = process.threadCpuUsage(thread);
      let allocatedBytes;
      if (values.mode === "allocation") {
        allocatedBytes = sum((await inspector.post("HeapProfiler.stopSampling")).profile.head);
      }
      if (expectedDigest) {
        assert.equal(digest(last), expectedDigest, "Context changed during measurement");
      }
      results.push({
        arm,
        sample,
        iterations,
        wallMs,
        processCpuMs: (processCpu.user + processCpu.system) / 1000,
        threadCpuMs: (threadCpu.user + threadCpu.system) / 1000,
        allocatedBytes,
        load: loadavg(),
      });
    }
  }
  if (values.mode === "profile") {
    fs.writeFileSync(
      `${values.output}.cpuprofile`,
      JSON.stringify((await inspector.post("Profiler.stop")).profile),
    );
  }
  for (const restore of restores) {
    restore();
  }
  restores.length = 0;
  syncBuiltinESMExports();
  fs.writeFileSync(
    values.output,
    JSON.stringify(
      {
        owner: values.owner,
        mode: values.mode,
        sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
        baselineSha256: baselineSource
          ? createHash("sha256").update(fs.readFileSync(baselineSource)).digest("hex")
          : undefined,
        coldMs,
        selectedSession,
        expectedDigest,
        context:
          values.owner === "context"
            ? {
                events: first.events.length,
                totalEvents: first.totalEvents,
                serializedBytes: first.serializedBytes,
                truncated: first.truncated,
              }
            : undefined,
        counts,
        results,
        node: process.version,
      },
      null,
      2,
    ),
  );
} finally {
  for (const restore of restores) {
    restore();
  }
  syncBuiltinESMExports();
  inspector.disconnect();
  await close();
}
