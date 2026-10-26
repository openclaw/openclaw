/**
 * Warm ingress IP CPU/allocation measurement with four proxy ranges and 64 clients.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/ingress-ip-measure.ts
 * Add --allocations for a separate allocation pass; its timings are not gates.
 * --source-root <path> selects a revision containing net.ts, net-policy/ip.ts and
 * normalization-core/string-coerce.ts. Exact ingress declarations are extracted
 * from net.ts to avoid loading unrelated interface-discovery dependencies; both
 * revisions use their own complete IP policy module. Requires ipaddr.js nearby.
 * --iterations defaults to 10000. Counterbalance base/candidate runs externally.
 * Acceptance: identical client IPs, fewer parses, and lower CPU/allocated bytes.
 * This isolates ingress attribution; it makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "source-root": { type: "string" },
    allocations: { type: "boolean", default: false },
    iterations: { type: "string", default: "10000" },
  },
});
const sourceRoot = path.resolve(
  values["source-root"] ?? fileURLToPath(new URL("../..", import.meta.url)),
);
const require = createRequire(import.meta.url);
const policySource = (
  await readFile(path.join(sourceRoot, "packages/net-policy/src/ip.ts"), "utf8")
)
  .replace('"ipaddr.js"', JSON.stringify(pathToFileURL(require.resolve("ipaddr.js")).href))
  .replace(
    '"@openclaw/normalization-core/string-coerce"',
    JSON.stringify(
      pathToFileURL(path.join(sourceRoot, "packages/normalization-core/src/string-coerce.ts")).href,
    ),
  );
function moduleUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`;
}
const netSource = await readFile(path.join(sourceRoot, "src/gateway/net.ts"), "utf8");
const startMarker = netSource.indexOf("function stripOptionalPort(");
const endMarker = netSource.indexOf("export function resolveRequestClientIpFromHeaders(");
assert(startMarker >= 0 && endMarker > startMarker, "ingress owner extraction markers missing");
const ingressSource = `
import net from "node:net";
import * as policy from ${JSON.stringify(moduleUrl(policySource))};
const { isIpInCidr, isParsedIpInCidr, normalizeIpAddress, parseIpAddressOrCidr, parseNormalizedIpAddress } = policy;
const isLoopbackAddress = policy.isLoopbackIpAddress;
${netSource.slice(startMarker, endMarker)}
`;
const { resolveClientIp }: typeof import("../../src/gateway/net.js") = await import(
  moduleUrl(ingressSource)
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const trustedProxies = ["127.0.0.1", "::1", "10.0.0.0/8", "2001:db8::/32"];
const fixtures = Array.from({ length: 64 }, (_, index) => {
  const client = `198.51.100.${index + 1}`;
  return {
    client,
    params: {
      remoteAddr: index % 2 ? "::ffff:10.0.0.2" : "2001:db8::2",
      forwardedFor: `${client}, 10.0.0.1, [2001:db8::1]`,
      trustedProxies,
    },
  };
});
for (const fixture of fixtures) {
  assert.equal(resolveClientIp(fixture.params), fixture.client);
}
function run(count: number): number {
  let checksum = 0;
  for (let index = 0; index < count; index++) {
    checksum += resolveClientIp(fixtures[index % fixtures.length]!.params)!.length;
  }
  return checksum;
}
run(1000);
global.gc?.();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
const checksum = run(iterations);
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const nodes = [profile.head];
  sampledBytes = 0;
  for (const node of nodes) {
    sampledBytes += node.selfSize;
    nodes.push(...node.children);
  }
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    iterations,
    checksum,
    hostLoad,
    ...(values.allocations
      ? { sampledBytes }
      : { elapsedMs, threadCpuMs: (cpu.user + cpu.system) / 1000 }),
  }),
);
