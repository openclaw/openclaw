/**
 * Catalog key allocation/CPU on frozen neutral, session, account, view, and option scopes.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-catalog-key-measure.mjs \
 *   [--owner .local/base-model-catalog-cache.ts] [--iterations 100000]
 * --owner overlays only the saved baseline module, retaining canonical dependency paths.
 * Alternate five serial baseline/candidate pairs. Acceptance: lower allocation/key,
 * non-adverse CPU/key, byte-identical keys, unchanged inputs. This measures key generation,
 * not RPC counts or production frequency. Requires Node 26 cumulative allocation counters.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: { owner: { type: "string" }, iterations: { type: "string", default: "100000" } },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26");
const ownerUrl = new URL("../../ui/src/lib/model-catalog-cache.ts", import.meta.url);
const source = readFileSync(values.owner ?? fileURLToPath(ownerUrl), "utf8");
const code = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
const hooks = registerHooks({
  load(url, context, next) {
    return url === ownerUrl.href
      ? { format: "module", source: code, shortCircuit: true }
      : next(url, context);
  },
});
const { modelCatalogKey } = await import(ownerUrl.href);
const fixtures = Array.from({ length: 40 }, (_, index) => {
  const agentId = `agent-${index % 4}`,
    provider = `provider-${index}`;
  const sessionKey = `agent:${agentId}:session-${index}`;
  const authProfileId = `personal:synthetic:${provider}`;
  const base = [["agentId", agentId]];
  return [
    [{ view: "configured", agentId }, [...base, ["view", "configured"]]],
    [
      { sessionKey, view: "configured", agentId },
      [...base, ["sessionKey", sessionKey], ["view", "configured"]],
    ],
    [
      { authProfileId, view: "configured", agentId },
      [...base, ["authProfileId", authProfileId], ["view", "configured"]],
    ],
    [{ provider, view: "all", agentId }, [...base, ["provider", provider], ["view", "all"]]],
    [
      { includeDetails: true, sessionKey, agentId },
      [...base, ["includeDetails", true], ["sessionKey", sessionKey]],
    ],
    [
      { includeProviderCapabilities: true, provider, agentId },
      [...base, ["includeProviderCapabilities", true], ["provider", provider]],
    ],
    [
      { preparedOnly: true, view: "configured", agentId },
      [...base, ["preparedOnly", true], ["view", "configured"]],
    ],
    [
      { refresh: true, provider: undefined, view: "provider-config", agentId },
      [...base, ["view", "provider-config"]],
    ],
  ].map(([params, entries]) => ({
    params: Object.freeze(params),
    expected: JSON.stringify(entries),
  }));
}).flat();
const originalInputs = JSON.stringify(fixtures);
function run(count) {
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index % fixtures.length];
    assert.equal(modelCatalogKey(fixture.params), fixture.expected);
  }
}
try {
  run(10000);
  globalThis.gc();
  await nextTurn();
  const hostLoad = { before: loadavg() };
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  run(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  hostLoad.after = loadavg();
  assert.equal(JSON.stringify(fixtures), originalInputs);
  console.log(
    JSON.stringify({
      node: process.version,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      distinctScopes: fixtures.length,
      providers: 40,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerKey: (cpu.user + cpu.system) / iterations,
      allocatedBytes,
      allocatedBytesPerKey: allocatedBytes / iterations,
      hostLoad,
    }),
  );
} finally {
  hooks.deregister();
}
