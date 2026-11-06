/**
 * Exact Responses prefix hashing over published replay entries, 20 interleaved sessions.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/responses-prefix-fingerprint-measure.ts
 *   --entries 50|500|2000 --baseline packages/ai/src/transports/.responses-prefix-baseline.ts
 * Preserve a baseline owner beside its source with git show before editing; both owners
 * consume identical production-converted/sanitized fixtures. Five counterbalanced A/A
 * pairs per owner. CPU and GC-inclusive allocation are separate.
 * Warm calls append one entry per session; cold calls use fresh immutable identities.
 * This isolates fingerprint cost; conversion, transport, database and network are excluded.
 * Accept exact legacy digests, suffix-only canonical encoding, lower warm CPU/allocation,
 * and disclose cold/retained-state cost. Do not infer Gateway latency or prompt-cache hits.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import { buildOpenAIResponsesParams } from "../../packages/ai/src/transports/openai-responses-params-internal.js";
import { sanitizeResponsesImagePayload } from "../../packages/ai/src/transports/responses-image-payload-sanitizer.js";
import type { Context, Model } from "../../packages/llm-core/src/types.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../src/shared/immutable-data.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: { entries: { type: "string", default: "500" }, baseline: { type: "string" } },
});
const entries = parseStrictIntegerOption({
  raw: values.entries,
  label: "entries",
  min: 1,
  fallback: 500,
});
assert(values.baseline, "Supply --baseline beside the original owner so relative imports resolve");
const paths = {
  baseline: resolve(values.baseline),
  candidate: resolve("packages/ai/src/transports/openai-responses-continuation.ts"),
};
type Fingerprint =
  typeof import("../../packages/ai/src/transports/openai-responses-continuation.js").responsesContinuationPrefixFingerprint;
const owners: Record<string, Fingerprint> = {};
for (const [side, path] of Object.entries(paths)) {
  owners[side] = (await import(pathToFileURL(path).href)).responsesContinuationPrefixFingerprint;
}
const gc = globalThis.gc;
assert(gc, "Use --expose-gc");
const sessions = 20;
const turns = 5;
const calls = sessions * turns;
const model: Model = {
  id: "fixture-model",
  name: "Synthetic",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const host = createAiTransportHost({
  immutableData: { freezeJsonSnapshot, isDeeplyFrozenPlainData },
});
const inspector = new Session();
inspector.connect();
await runWithAiTransportHost(host, async () => {
  function fixture() {
    return Array.from({ length: sessions }, (_session, session) => {
      const messages: Context["messages"] = Array.from(
        { length: entries + turns },
        (_entry, index) =>
          freezeJsonSnapshot({
            role: "user" as const,
            content: `session ${session} entry ${index} ${"x".repeat(2048)}`,
            timestamp: index,
          }),
      );
      const input =
        sanitizeResponsesImagePayload(buildOpenAIResponsesParams(model, { messages }, {})).input ??
        [];
      assert.equal(input.length, entries + turns);
      assert(
        input.every(isDeeplyFrozenPlainData),
        "Production preparation lost immutable entry ownership",
      );
      const golden = (length: number) =>
        hash(
          "sha256",
          `[${messages
            .slice(0, length)
            .map(
              (message) =>
                `{"content":[{"text":${JSON.stringify(message.content)},"type":"input_text"}],"role":"user","type":"message"}`,
            )
            .join(",")}]`,
        );
      return {
        initial: input.slice(0, entries),
        requests: Array.from({ length: turns }, (_turn, turn) =>
          input.slice(0, entries + turn + 1),
        ),
        expected: golden(entries + turns),
      };
    });
  }
  function warm(fixtures: ReturnType<typeof fixture>, fingerprint: Fingerprint) {
    for (const current of fixtures) {
      fingerprint(current.initial);
    }
  }
  function run(fixtures: ReturnType<typeof fixture>, fingerprint: Fingerprint) {
    for (let turn = 0; turn < turns; turn++) {
      for (const current of fixtures) {
        const digest = fingerprint(current.requests[turn]!);
        if (turn === turns - 1) {
          assert.equal(digest, current.expected);
        }
      }
    }
  }
  const parity = fixture();
  for (const fingerprint of Object.values(owners)) {
    warm(parity, fingerprint);
    run(parity, fingerprint);
  }
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
  run(parity, owners.candidate!);
  const coverage = (await inspector.post("Profiler.takePreciseCoverage")).result;
  await inspector.post("Profiler.stopPreciseCoverage");
  await inspector.post("Profiler.disable");
  const functions = coverage.flatMap((script) =>
    script.functions
      .filter((fn) =>
        ["stableStringify", "sha256StableValue", "projectJsonValue"].includes(fn.functionName),
      )
      .map((fn) => ({ name: fn.functionName, count: fn.ranges[0]?.count ?? 0 })),
  );
  console.log(
    JSON.stringify({
      entries,
      sessions,
      calls,
      node: process.version,
      ownerSha256: Object.fromEntries(
        Object.entries(paths).map(([side, path]) => [side, hash("sha256", readFileSync(path))]),
      ),
      expectedHash: parity[0]?.expected,
      historyBytes: Buffer.byteLength(JSON.stringify(parity[0]?.initial)),
      repeatedWork: functions,
    }),
  );
  for (let sample = 0; sample < 5; sample++) {
    for (const side of sample % 2 === 0
      ? ["baseline-A1", "candidate-A1", "baseline-A2", "candidate-A2"]
      : ["candidate-A2", "baseline-A2", "candidate-A1", "baseline-A1"]) {
      const fingerprint = owners[side.split("-")[0]!]!;
      for (const cold of [false, true]) {
        const timings = fixture();
        if (!cold) {
          warm(timings, fingerprint);
        }
        gc();
        const cpu0 = process.cpuUsage(),
          t0 = performance.now();
        if (cold) {
          warm(timings, fingerprint);
        } else {
          run(timings, fingerprint);
        }
        const wallMs = performance.now() - t0,
          cpu = process.cpuUsage(cpu0);
        const allocations = fixture();
        if (!cold) {
          warm(allocations, fingerprint);
        }
        gc();
        await inspector.post("HeapProfiler.startSampling", {
          samplingInterval: 4096,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        });
        if (cold) {
          warm(allocations, fingerprint);
        } else {
          run(allocations, fingerprint);
        }
        const { profile } = await inspector.post("HeapProfiler.stopSampling");
        const count = cold ? sessions : calls;
        console.log(
          JSON.stringify({
            sample,
            side,
            cold,
            cpuUsPerRequest: (cpu.user + cpu.system) / count,
            wallUsPerRequest: (wallMs * 1000) / count,
            sampledBytesPerRequest:
              profile.samples.reduce((sum, value) => sum + value.size, 0) / count,
            load: loadavg(),
          }),
        );
      }
    }
  }
});
inspector.disconnect();
