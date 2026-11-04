/**
 * Claude binding owner microbenchmark, 10k frozen synthetic session summaries.
 * node --import ./scripts/tsx.mjs scripts/perf/claude-session-catalog-measure.ts \
 *   --owner-file .local/buf290/base-session-catalog-runtime.ts --iterations 3000
 * Omit --owner-file for candidate; add --allocations for a separate sampled pass.
 * --unchanged measures a retained revision; default replaces it each call.
 * Alternate base/candidate runs. No Gateway, SQL, provider I/O or transport claim.
 * Owner and SDK enumeration are real; agent/config discovery is a fixed fixture.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { SessionCatalogEntrySnapshot } from "../../src/plugins/session-catalog.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
    unchanged: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../extensions/anthropic/session-catalog-runtime.ts", import.meta.url);
const catalogUrl = new URL("../../src/plugins/session-catalog.ts", import.meta.url);
const ownerSource = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
const fixtureUrl = `data:text/javascript,${encodeURIComponent(`
export const listAgentIds = () => ['main'];
export const resolveSessionAgentIds = () => ({defaultAgentId: 'main', sessionAgentId: 'main'});
export const resolveEffectiveAgentRuntime = () => { throw new Error('Unexpected runtime lookup'); };
`)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === ownerUrl.href) {
      if (specifier === "openclaw/plugin-sdk/command-auth-native") {
        return { url: fixtureUrl, shortCircuit: true };
      }
      if (specifier === "openclaw/plugin-sdk/session-catalog") {
        return { url: catalogUrl.href, shortCircuit: true };
      }
      if (specifier === "openclaw/plugin-sdk/string-coerce-runtime") {
        return next("@openclaw/normalization-core/record-coerce", context);
      }
    }
    return context.parentURL === catalogUrl.href && specifier.endsWith("/agent-scope.js")
      ? { url: fixtureUrl, shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === ownerUrl.href
      ? { format: "module", source: stripTypeScriptTypes(ownerSource), shortCircuit: true }
      : next(url, context);
  },
});
const {
  listBoundClaudeSessions,
}: typeof import("../../extensions/anthropic/session-catalog-runtime.js") = await import(
  ownerUrl.href
);
hooks.deregister();
const entries = Array.from({ length: 10_000 }, (_, index) =>
  Object.freeze({
    agentId: "main",
    sessionKey: `agent:main:synthetic-${index}`,
    entry: Object.freeze({
      sessionId: `synthetic-${index}`,
      updatedAt: index,
      ...(index % 100 === 0
        ? { cliSessionBindings: { "claude-cli": { sessionId: `thread-${index}` } } }
        : index % 100 === 1
          ? {
              pluginOwnerId: "anthropic",
              modelSelectionLocked: true,
              pluginExtensions: {
                anthropic: { sessionCatalog: { sourceThreadId: `thread-${index}` } },
              },
            }
          : { archivedAt: index + 1 }),
    }),
  }),
);
Object.freeze(entries);
const config = {};
const api = {
  id: "anthropic",
  runtime: { config: { current: () => config } },
} as OpenClawPluginApi;
const snapshot: SessionCatalogEntrySnapshot = {
  revision: {},
  entriesForAgent: () => entries,
  entriesForCatalog: () => entries,
};
let result: ReturnType<typeof listBoundClaudeSessions>;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    if (!values.unchanged) {
      snapshot.revision = {};
    }
    result = listBoundClaudeSessions(api, "main", snapshot);
  }
}
run(100);
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const cpu = process.threadCpuUsage();
const start = performance.now();
run(iterations);
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
let allocatedBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  allocatedBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(result!.size, 200);
for (let index = 0; index < 10_000; index += 100) {
  for (const offset of [0, 1]) {
    assert.deepEqual(result!.get(`gateway:local\0thread-${index + offset}`), {
      adopted: offset === 1,
      sessionKey: `agent:main:synthetic-${index + offset}`,
    });
  }
}
console.log(
  JSON.stringify({
    ownerSha256: hash("sha256", ownerSource),
    iterations,
    sessions: entries.length,
    unchanged: values.unchanged,
    allocations: values.allocations,
    wallMs,
    mainThreadCpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    hostLoad: loadavg(),
  }),
);
