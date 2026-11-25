// Compare real templates.catalog.detail responses on already-running isolated Gateways.
// node --import ./scripts/tsx.mjs scripts/bench-template-detail.mts
//   --baseline-config <path> --candidate-config <path> --output <path>
// Both Gateways must use the same registry and workload. Never prints credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../src/config/config.js";
import { callGateway } from "../src/gateway/call.js";

const { values } = parseArgs({
  options: {
    "baseline-config": { type: "string" },
    "candidate-config": { type: "string" },
    output: { type: "string" },
    package: { type: "string", default: "@openclaw/research-monitor" },
    version: { type: "string", default: "0.1.2" },
    samples: { type: "string", default: "5" },
  },
});
if (!values["baseline-config"] || !values["candidate-config"] || !values.output) {
  throw new Error("Pass --baseline-config, --candidate-config, and --output.");
}
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples >= 5);
const configs = await Promise.all(
  [values["baseline-config"], values["candidate-config"]].map(
    async (file) => JSON.parse(await fs.readFile(file!, "utf8")) as OpenClawConfig,
  ),
);
const runs: Array<{ arm: string; sample: number; ms: number; loadavg: number[] }> = [];
let reference: unknown;
for (let sample = 1; sample <= samples; sample++) {
  for (const index of [0, 1]) {
    const config = configs[index]!;
    const token = config.gateway?.auth?.token;
    assert(typeof token === "string" && token.trim(), "Benchmark configs require a string token.");
    const start = performance.now();
    const response = await callGateway({
      config,
      url: `ws://127.0.0.1:${config.gateway!.port}`,
      token,
      skipImplicitAuth: true,
      method: "templates.catalog.detail",
      params: { packageName: values.package, version: values.version },
      timeoutMs: 120_000,
    });
    const ms = performance.now() - start;
    if (reference === undefined) {
      reference = response;
    } else {
      assert.deepStrictEqual(response, reference);
    }
    const run = { arm: index === 0 ? "baseline" : "candidate", sample, ms, loadavg: loadavg() };
    runs.push(run);
    console.log(JSON.stringify(run));
  }
}
const summary = ["baseline", "candidate"].map((arm) => {
  const times = runs
    .filter((run) => run.arm === arm)
    .map((run) => run.ms)
    .toSorted((a, b) => a - b);
  return {
    arm,
    averageMs: times.reduce((a, b) => a + b, 0) / times.length,
    medianMs: times[Math.floor(times.length / 2)],
    p95Ms: times[Math.ceil(times.length * 0.95) - 1],
    minMs: times[0],
    maxMs: times.at(-1),
  };
});
await fs.writeFile(
  values.output,
  JSON.stringify(
    {
      metric:
        "Fresh authenticated Gateway connection plus full verified detail response; excludes process/module startup",
      packageName: values.package,
      version: values.version,
      parity: true,
      runs,
      summary,
      response: reference,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(summary));
