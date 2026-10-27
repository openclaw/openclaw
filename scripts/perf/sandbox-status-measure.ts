/**
 * Sandbox status owner allocation/CPU comparison; synthetic config, no Gateway/provider.
 * node --import ./scripts/tsx.mjs scripts/perf/sandbox-status-measure.ts \
 *   --output .local/status-base.json --iterations 10000 --owner-dir .local/base
 * Repeat interleaved against current source without --owner-dir. Add --allocations
 * for a separate V8 sampling pass (includes collected objects, interval 1024 bytes).
 * --owner-dir contains captured src/agents/sandbox/{config,runtime-status}.ts;
 * all other imports keep their real URLs. Receipts pin the measured source bytes.
 * Each iteration classifies one of 10,000 prepared synthetic sessions across four
 * agents, with 40 plugin entries and 160 sandbox tool patterns. No state database
 * or container is created. Both minimal and configured-container cases are run.
 * Acceptance: identical status digests, one tool-policy resolution per status,
 * reduced allocation/CPU. This is owner evidence, not handler or Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "10000" },
    "owner-dir": { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output, "--output required");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const receipts: Array<{ file: string; sha256: string }> = [];
const overrides = new Map<string, string>();
for (const file of ["config", "runtime-status"]) {
  const relative = `src/agents/sandbox/${file}.ts`;
  const url = new URL(`../../${relative}`, import.meta.url);
  const source = readFileSync(
    values["owner-dir"] ? path.join(values["owner-dir"], relative) : url,
    "utf8",
  );
  receipts.push({ file: relative, sha256: createHash("sha256").update(source).digest("hex") });
  if (values["owner-dir"]) {
    const { transformSync } = await import("esbuild");
    overrides.set(
      url.href,
      transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code,
    );
  }
}
if (overrides.size) {
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      const source = overrides.get(url);
      return source === undefined ? loaded : { ...loaded, source };
    },
  });
}
const { resolvePreparedSandboxRuntimeStatus } =
  await import("../../src/agents/sandbox/runtime-status.js");
const plugins = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`fixture-${i}`, { enabled: true }]),
);
const allow = Array.from({ length: 160 }, (_, i) => `fixture_tool_${i}*`);
const agents = ["fixture-a", "fixture-b", "fixture-c", "fixture-d"];
const sessions = Array.from({ length: 10000 }, (_, i) => ({
  agentId: agents[i % agents.length],
  sessionKey: `agent:${agents[i % agents.length]}:dashboard:fixture-${i}`,
  preparedSessionEntry: i % 3 === 0 ? { sandbox: "required" as const } : null,
}));
const env = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`FIXTURE_${i}`, `value-${i}`]),
);
const configs: Array<{ name: string; cfg: OpenClawConfig }> = [false, true].map((rich) => ({
  name: rich ? "configured-container" : "minimal-container",
  cfg: {
    plugins: { entries: plugins },
    tools: { sandbox: { tools: { allow, deny: ["fixture_denied*"] } } },
    agents: {
      ownership: "explicit",
      defaults: {
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          ...(rich
            ? {
                docker: {
                  env,
                  binds: Array.from({ length: 40 }, (_, i) => `/synthetic/${i}:/data/${i}:ro`),
                },
                browser: { binds: ["/synthetic/browser:/data:ro"] },
                ssh: { target: "fixture.invalid", workspaceRoot: "/synthetic/sandboxes" },
              }
            : {}),
        },
      },
      entries: Object.fromEntries(
        agents.map((id) => [
          id,
          {
            sandbox: {
              workspaceAccess: "ro",
              ...(rich ? { docker: { env: { FIXTURE_AGENT: id } } } : {}),
            },
          },
        ]),
      ),
    },
  },
}));
const results = [];
for (const { name, cfg } of configs) {
  const run = (i: number) =>
    resolvePreparedSandboxRuntimeStatus({ cfg, ...sessions[i % sessions.length] });
  const digest = createHash("sha256");
  for (let i = 0; i < sessions.length; i++) {
    digest.update(JSON.stringify(run(i)));
  }
  const inspector = new Session();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const heapStart = process.memoryUsage().heapUsed;
  const cpuStart = process.threadCpuUsage();
  const started = performance.now();
  let sandboxed = 0;
  for (let i = 0; i < iterations; i++) {
    sandboxed += Number(run(i).sandboxed);
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const heapDelta = process.memoryUsage().heapUsed - heapStart;
  assert.equal(sandboxed, iterations);
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    mkdirSync(path.dirname(values.output), { recursive: true });
    writeFileSync(`${values.output}.${name}.heapprofile`, JSON.stringify(profile));
  }
  results.push({
    name,
    iterations,
    hostLoad,
    wallMs,
    cpuUsPerCall: (cpu.user + cpu.system) / iterations,
    sampledBytesPerCall: sampledBytes === undefined ? null : sampledBytes / iterations,
    heapDelta,
    responseDigest: digest.digest("hex"),
  });
}
mkdirSync(path.dirname(values.output), { recursive: true });
const result = { node: process.version, allocations: values.allocations, receipts, results };
writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
