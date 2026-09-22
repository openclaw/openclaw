// Run on baseline and candidate: node --import ./scripts/tsx.mjs scripts/bench-redaction-prefilters.ts
// Synthetic warm-path CPU timings; this does not estimate total Gateway CPU savings.
import os from "node:os";
import { performance } from "node:perf_hooks";
import { AWS_SECRET_ACCESS_KEY_MATCHER } from "../src/logging/redact-patterns.js";
import {
  redactModelVisibleToolPayloadTextWithConfig,
  redactToolPayloadTextWithConfig,
} from "../src/logging/redact.js";

const samples = 9;
const warmups = 2;
const iterations = 200;
const secret = "Ab9+".repeat(10);
const corpus = {
  short: ["ok", "***", "No results found", "token = timeObserverToken", "password: ***"],
  prose: ["The operation completed successfully. All checks passed.\n".repeat(80)],
  source: [
    'export function readToken(token: string) {\n return { token, status: "ready", count: 123 };\n}\n'.repeat(
      40,
    ),
  ],
  json: [
    JSON.stringify(
      Array.from({ length: 50 }, (_, id) => ({ id, status: "ready", tokens: 42, output: "Done" })),
    ),
  ],
  masked: ["Authorization: Bearer ***\nAPI_KEY=***\n".repeat(60)],
  secret: [`value ${secret} end`],
  base64: ["Ab9+".repeat(1_000)],
  hex: ["0123456789abcdef".repeat(3)],
};
const operations = {
  candidate: (text: string) => AWS_SECRET_ACCESS_KEY_MATCHER.couldMatch(text),
  matcher: (text: string) => [...AWS_SECRET_ACCESS_KEY_MATCHER.exec(text)].length,
  tool: (text: string) => redactModelVisibleToolPayloadTextWithConfig(text, {}),
  diagnostic: (text: string) => redactToolPayloadTextWithConfig(text, {}),
};
let checksum = 0;
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const [scenario, texts] of Object.entries(corpus)) {
  for (const [operation, run] of Object.entries(operations)) {
    const cpuSamples: number[] = [];
    const elapsedSamples: number[] = [];
    for (let sample = -warmups; sample < samples; sample++) {
      const cpu = process.threadCpuUsage();
      const start = performance.now();
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (const text of texts) {
          checksum += Number(Boolean(run(text)));
        }
      }
      const elapsed = performance.now() - start;
      const used = process.threadCpuUsage(cpu);
      if (sample >= 0) {
        cpuSamples.push((used.user + used.system) / (iterations * texts.length));
        elapsedSamples.push((elapsed * 1_000) / (iterations * texts.length));
      }
    }
    results.push({
      scenario,
      operation,
      inputChars: texts.map((text) => text.length),
      medianCpuUs: median(cpuSamples),
      medianElapsedUs: median(elapsedSamples),
    });
  }
}
console.log(
  JSON.stringify({
    node: process.version,
    cpu: os.cpus()[0]?.model,
    samples,
    warmups,
    iterations,
    maxRssKiB: process.resourceUsage().maxRSS,
    checksum,
    results,
  }),
);
