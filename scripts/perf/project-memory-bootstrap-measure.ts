/**
 * Real Knowledge native-provider project recall with synthetic approved records.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/project-memory-bootstrap-measure.ts \
 *   --root .local/lane2135/native --records 6000 --projects 200 --iterations 20
 * The first invocation requires a fresh --root; it seeds and adopts a new store.
 * Add --reuse-fixture on later invocations to measure fresh owners reopening the
 * populated store without rewriting files, session rows, or initial checkpoints.
 * Repeat in fresh processes, alternating --baseline-dir <saved owner sources> and
 * current source at least five times. Cold includes lazy provider/storage startup;
 * warm holds the real registry, audience, workers and store. This is the Gateway's
 * owner path, not a chat.send/Gateway latency measurement. Allocation sampling is
 * main-thread only; process CPU includes storage/registry worker CPU.
 * Acceptance: identical prompt bytes and no material timing/CPU/allocation regression
 * for diagnostic-only changes. Keep untraced timing and --mode allocation separate.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "baseline-dir": { type: "string" },
    "reuse-fixture": { type: "boolean", default: false },
    records: { type: "string", default: "6000" },
    projects: { type: "string", default: "200" },
    iterations: { type: "string", default: "20" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values.root, "--root must name an isolated synthetic fixture directory");
const root = path.resolve(values.root);
const count = Number(values.records);
const projects = Number(values.projects);
const iterations = Number(values.iterations);
for (const n of [count, projects, iterations]) {
  assert(Number.isSafeInteger(n) && n > 0);
}
assert(["timing", "allocation"].includes(values.mode));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_AGENT_DIR = path.join(root, "state", "agents", "main", "agent");

const replacements = new Map([
  [
    new URL("../../src/agents/project-memory-bootstrap.ts", import.meta.url).href,
    "base-project-memory-bootstrap.ts",
  ],
  [new URL("../../src/plugins/memory-runtime.ts", import.meta.url).href, "base-memory-runtime.ts"],
  [
    new URL("../../src/plugins/memory-provider-adapter.ts", import.meta.url).href,
    "base-memory-provider-adapter.ts",
  ],
]);
const loadedReplacements = new Set<string>();
const ownerSources = Object.fromEntries(
  [...replacements].map(([url, file]) => [
    file,
    createHash("sha256")
      .update(
        readFileSync(
          values["baseline-dir"] ? path.join(values["baseline-dir"], file) : new URL(url),
        ),
      )
      .digest("hex"),
  ]),
);
const hooks = values["baseline-dir"]
  ? registerHooks({
      load(url, context, next) {
        const replacement = replacements.get(url);
        if (replacement) {
          loadedReplacements.add(replacement);
        }
        return replacement
          ? {
              format: "module",
              source: stripTypeScriptTypes(
                readFileSync(path.join(values["baseline-dir"]!, replacement), "utf8"),
              ),
              shortCircuit: true,
            }
          : next(url, context);
      },
    })
  : undefined;

const [
  { createKnowledgeMemoryRuntime },
  { Stores },
  { StoreRegistry },
  { parsePolicy },
  { createPluginRuntime },
  { createPluginRegistry },
  { createPluginRecord },
  { createPluginRegistryOwner },
  { withPluginRuntimeRegistryScope },
  { setRuntimeConfigSnapshot },
  { replaceSessionEntrySync },
  { resolveOpenClawAgentSqlitePath },
  { resolveMemoryAudienceFromEntry },
  { withDiagnosticsTimelineObserver },
  { prepareProjectMemoryBootstrap },
] = await Promise.all([
  import("../../extensions/knowledge/src/memory-provider.js"),
  import("../../extensions/knowledge/src/stores.js"),
  import("../../extensions/knowledge/src/store-registry.js"),
  import("../../extensions/knowledge/src/stores-config.js"),
  import("../../src/plugins/runtime/index.js"),
  import("../../src/plugins/registry.js"),
  import("../../src/plugins/loader-records.js"),
  import("../../src/plugins/runtime.js"),
  import("../../src/plugins/runtime/gateway-request-scope.js"),
  import("../../src/config/runtime-snapshot.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-replace.js"),
  import("../../src/state/openclaw-agent-db.paths.js"),
  import("../../src/plugins/memory-audience.js"),
  import("../../src/infra/diagnostics-timeline.js"),
  import("../../src/agents/project-memory-bootstrap.js"),
]);

const cfg = {
  agents: {
    entries: { main: {} },
    defaults: { workspace: path.join(root, "workspace") },
  },
  plugins: {
    slots: { memory: "knowledge" },
    entries: { knowledge: { enabled: true, config: {} } },
  },
};
setRuntimeConfigSnapshot(cfg);
const vaultRoot = path.join(root, "vault");
let fixtureBytes = 0;
if (values["reuse-fixture"]) {
  const files = readdirSync(path.join(vaultRoot, "private")).filter((file) => file.endsWith(".md"));
  assert.equal(files.length, count, "reopened fixture must have the requested record count");
  fixtureBytes = files.reduce(
    (total, file) => total + statSync(path.join(vaultRoot, "private", file)).size,
    0,
  );
} else {
  mkdirSync(root, { recursive: true });
  writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
  mkdirSync(path.join(vaultRoot, "private"), { recursive: true });
  const vaultId = "11111111-1111-4111-8111-111111111111";
  const publicationId = "22222222-2222-4222-8222-222222222222";
  writeFileSync(
    path.join(vaultRoot, "vault.json"),
    JSON.stringify({ format: "knowledge-vault-v2", vaultId, generation: 0, publicationId }),
  );
  for (let i = 0; i < count; i++) {
    const metadata = {
      format: "knowledge-record-v1",
      id: `fixture_${String(i).padStart(8, "0")}`,
      revision: 1,
      kind: "page",
      title: `Synthetic curated fact ${i}`,
      type: "note",
      scope: { visibility: "private" },
      recorded_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      lifecycle: "active",
      recall: {
        summary: `Synthetic project ${i % projects} fact ${i}: use the documented release procedure.`,
        projects: [`github.com/synthetic/project-${i % projects}`],
        importance: 10,
        approved_by: "owner-private",
        approved_at: "2026-01-01T00:00:00Z",
      },
    };
    const content = `---\n${JSON.stringify(metadata)}\n---\n\n${"Synthetic durable context. ".repeat(40)}\n`;
    writeFileSync(path.join(vaultRoot, "private", `${metadata.id}.md`), content);
    fixtureBytes += Buffer.byteLength(content);
  }
  const registrySeed = new StoreRegistry(path.join(process.env.OPENCLAW_STATE_DIR, "knowledge"));
  registrySeed.adopt("agent:main", {
    vaultId,
    publicationId,
    root: vaultRoot,
    statePath: path.join(root, "knowledge.sqlite"),
  });
  registrySeed.close();
}

const sessionKey = "agent:main:fixture";
const entry = {
  sessionId: "33333333-3333-4333-8333-333333333333",
  lifecycleRevision: "44444444-4444-4444-8444-444444444444",
  updatedAt: 1,
  chatType: "direct" as const,
};
if (!values["reuse-fixture"]) {
  replaceSessionEntrySync({ agentId: "main", sessionKey }, entry);
}
const audience = await resolveMemoryAudienceFromEntry(
  {
    agentId: "main",
    sessionKey,
    sessionId: entry.sessionId,
    senderIsOwner: true,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  },
  entry,
);
if (audience.status !== "granted") {
  throw new Error(audience.reason);
}
const runtime = createPluginRuntime();
const stores = new Stores({ runtime }, parsePolicy({}), () => {});
const registry = createPluginRegistry({
  runtime,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  activateGlobalSideEffects: false,
});
const record = createPluginRecord({
  id: "knowledge",
  source: new URL("../../extensions/knowledge/index.ts", import.meta.url).pathname,
  origin: "bundled",
  enabled: true,
  configSchema: false,
});
record.kind = "memory";
record.memorySlotSelected = true;
registry.registry.plugins.push(record);
registry
  .createApi(record, { config: cfg })
  .registerMemoryCapability({ providerRuntime: createKnowledgeMemoryRuntime(stores) });
const owner = createPluginRegistryOwner(registry.registry);
let active = true;
const context = {
  authority: {
    kind: "session" as const,
    sessionKey,
    sessionId: entry.sessionId,
    sandboxed: false,
    audience: audience.audience,
  },
  assertCurrent() {
    assert(active, "fixture authority revoked");
  },
};
let expected: string | undefined;
const run = async () => {
  const phases: Record<string, number> = {};
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  const lines = await withDiagnosticsTimelineObserver(
    (name, _attributes, duration) => {
      const phaseStart = performance.now();
      return () => {
        phases[name] = (phases[name] ?? 0) + (duration ?? performance.now() - phaseStart);
      };
    },
    () =>
      prepareProjectMemoryBootstrap({
        cfg,
        agentId: "main",
        activeProjectKeys: ["github.com/synthetic/project-0"],
        context,
      }),
  );
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const main = process.threadCpuUsage(thread);
  const bytes = lines.join("\n");
  assert(
    bytes.includes("Synthetic project 0 fact 0"),
    "native provider must return the seeded project memory",
  );
  expected ??= bytes;
  assert.equal(bytes, expected, "project prompt bytes changed between preparations");
  return {
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    mainCpuMs: (main.user + main.system) / 1000,
    phases,
  };
};
const inspector = new Session();
try {
  await withPluginRuntimeRegistryScope(registry.registry, async () => {
    const cold = await run();
    if (values["baseline-dir"]) {
      assert.equal(loadedReplacements.size, replacements.size);
    }
    global.gc?.();
    if (values.mode === "allocation") {
      await startCollectedHeapSampling(inspector, 4096);
    }
    const warm = [];
    for (let i = 0; i < iterations; i++) {
      warm.push(await run());
    }
    let allocatedBytes: number | undefined;
    if (values.mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocatedBytes = sumSampledHeapBytes(profile.head);
      inspector.disconnect();
    }
    console.log(
      JSON.stringify({
        mode: values.mode,
        baseline: values["baseline-dir"] ?? null,
        ownerSources,
        fixture: { count, projects, fixtureBytes, reused: values["reuse-fixture"] },
        cold,
        warm,
        allocatedBytes,
        bytesPerOperation: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        promptSha256: createHash("sha256").update(expected!).digest("hex"),
        hostLoad: loadavg(),
        memory: process.memoryUsage(),
      }),
    );
  });
} finally {
  active = false;
  audience.release();
  hooks?.deregister();
  await owner.close();
  await stores.dispose();
}
