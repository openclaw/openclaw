// Delivery-owner microbenchmark over 10,000 canonical session rows, with fixed store I/O.
// node --import ./scripts/tsx.mjs scripts/perf/delivery-info-measure.ts [--owner saved-owner.ts]
// Use --allocations for a separate sampled-allocation pass; its timing is diagnostic only.
// --scenario signal measures the retained folded-Signal fallback. --iterations defaults to 3000.
// This measures delivery selection/index work, not SQLite, worker transport, or Gateway latency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionEntrySummary } from "../../src/config/sessions/session-accessor.types.js";
import { normalizeSessionDeliveryState } from "../../src/utils/delivery-context.shared.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "3000" },
    scenario: { type: "string", default: "ordinary" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.scenario === "ordinary" || values.scenario === "signal");
const ownerUrl = new URL("../../src/config/sessions/delivery-info.ts", import.meta.url);
const ownerSource = readFileSync(values.owner ?? ownerUrl, "utf8");
const telegramContext = { channel: "telegram", to: "telegram:synthetic", accountId: "default" };
const signalContext = { channel: "signal", to: "signal:group:AbC", accountId: "default" };
const rows: SessionEntrySummary[] = Array.from({ length: 10_000 }, (_, index) => ({
  sessionKey: `agent:main:subagent:synthetic-${index}`,
  entry: { sessionId: `synthetic-${index}`, updatedAt: index },
}));
rows[0] = {
  sessionKey: "agent:main:telegram:dm:synthetic",
  entry: {
    sessionId: "synthetic-route",
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({ context: telegramContext }),
  },
};
rows[1] = {
  sessionKey: "agent:main:signal:group:AbC",
  entry: {
    sessionId: "synthetic-signal",
    updatedAt: 2,
    delivery: normalizeSessionDeliveryState({ context: signalContext }),
  },
};
const byKey = new Map(rows.map((row) => [row.sessionKey, row]));
const fixture = {
  exactReads: 0,
  inventories: 0,
  async readSessionEntriesFromStoreInWorker(scope: { sessionKeys: readonly string[] }) {
    fixture.exactReads++;
    return {
      entries: scope.sessionKeys.flatMap((key) => {
        const row = byKey.get(key);
        return row ? [row] : [];
      }),
      source: { agentId: "main", path: "/synthetic/delivery/sessions.sqlite" },
    };
  },
  async readSessionEntrySummariesInWorker() {
    fixture.inventories++;
    return rows;
  },
};
const fixtureSymbol = Symbol.for("openclaw.delivery-info-measure");
Reflect.set(globalThis, fixtureSymbol, fixture);
const fixtures = new Map<string, string>();
const replaceImport = (relative: string, source: string) => {
  fixtures.set(new URL(relative, ownerUrl).href, source);
};
replaceImport(
  "./session-entry-read-runtime.ts",
  `const fixture = globalThis[Symbol.for("openclaw.delivery-info-measure")];
   export const readSessionEntriesFromStoreInWorker = fixture.readSessionEntriesFromStoreInWorker;
   export const readSessionEntrySummariesInWorker = fixture.readSessionEntrySummariesInWorker;
   export const readSessionEntryReadOnlyInWorker = () => { throw new Error("Unexpected exact read"); };`,
);
replaceImport("../io.ts", "export const getRuntimeConfig = () => ({});");
replaceImport(
  "./targets-runtime.ts",
  `export const resolveAllAgentSessionStoreTargetsAsync = async () =>
    [{agentId: "main", storePath: "/synthetic/delivery/sessions.sqlite"}];`,
);
replaceImport(
  "./paths.ts",
  'export const resolveSessionStorePathCore = () => "/synthetic/delivery/sessions.sqlite";',
);
replaceImport(
  "./session-accessor.memory-exact-read.ts",
  'export const captureMemoryExactSessionReader = () => { throw new Error("Unexpected memory read"); };',
);
// All fixtures are qualified main-agent keys and use generic thread grammar. Keep the real
// normalization/alias/delivery selection code; replace upstream routing and plugin discovery.
replaceImport(
  "../../gateway/session-store-key.ts",
  `import { normalizeStoreSessionKey } from "../config/sessions/store-entry.js";
   export const resolveSessionStoreKey = ({sessionKey}) => normalizeStoreSessionKey(sessionKey);
   export const resolveSessionStoreIdentity = ({sessionKey}) =>
     ({agentId: "main", canonicalKey: normalizeStoreSessionKey(sessionKey)});`,
);
replaceImport(
  "../../channels/plugins/session-conversation.ts",
  'export { parseThreadSessionSuffix as resolveSessionThreadInfo } from "../../sessions/session-key-utils.js";',
);
let ownerLoaded = false;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === ownerUrl.href) {
      ownerLoaded = true;
      return { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true };
    }
    const source = fixtures.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const { extractDeliveryInfoBatch } = await import("../../src/config/sessions/delivery-info.js");
hooks.deregister();
assert(ownerLoaded, "The selected delivery owner must be loaded");
const scenarios =
  values.scenario === "signal"
    ? [{ sessionKey: "agent:main:signal:group:abc", context: signalContext }]
    : [
        { sessionKey: "agent:main:missing", context: undefined },
        { sessionKey: "agent:main:subagent:synthetic-9999", context: undefined },
        { sessionKey: "AGENT:main:TELEGRAM:dm:synthetic", context: telegramContext },
        { sessionKey: "agent:main:matrix:channel:!Missing:Example.Org", context: undefined },
      ];
const expected = scenarios.map(({ context }) =>
  JSON.stringify([{ deliveryContext: context, threadId: undefined }]),
);
async function run(count: number) {
  const digest = createHash("sha256");
  for (let index = 0; index < count; index++) {
    const scenarioIndex = index % scenarios.length;
    const result = JSON.stringify(
      await extractDeliveryInfoBatch([{ sessionKey: scenarios[scenarioIndex]!.sessionKey }], {
        cfg: {},
      }),
    );
    assert.equal(result, expected[scenarioIndex]);
    digest.update(result);
    if (index % 100 === 0) {
      await nextTurn();
    }
  }
  return digest.digest("hex");
}
await run(Math.min(iterations, 100));
fixture.exactReads = 0;
fixture.inventories = 0;
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const stopDiagnostics = startGatewayBenchDiagnostics();
const cpu = process.threadCpuUsage();
const start = performance.now();
const resultDigest = await run(iterations);
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
await nextTurn();
await nextTurn();
const diagnostics = stopDiagnostics();
assert.equal(fixture.exactReads, iterations, "Every delivery must reach its store read");
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
Reflect.deleteProperty(globalThis, fixtureSymbol);
console.log(
  JSON.stringify({
    scenario: values.scenario,
    iterations,
    entries: rows.length,
    ownerSha256: createHash("sha256").update(ownerSource).digest("hex"),
    wallMs,
    threadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    inventories: fixture.inventories,
    exactReads: fixture.exactReads,
    resultDigest,
    memory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    diagnostics,
  }),
);
