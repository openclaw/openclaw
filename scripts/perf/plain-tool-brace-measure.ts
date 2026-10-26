/** Fixed owner workload; run serially on base/head with node --import ./scripts/tsx.mjs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { createAssistantVisibleStreamText } from "../../src/agents/embedded-agent-utils.js";

const size = 32_768;
const sources = [
  [
    "pretty-printed JSON",
    `{\n${'  {"id":0,"label":"ordinary value"},\n'.repeat(1024)}  "done": true\n}`,
  ],
  [
    "brace-heavy prose",
    'Configure the value as {"mode":"fast"} before starting the service and continue. '.repeat(512),
  ],
] as const;
const cases = sources.map(([shape, input]) => {
  const source = input.slice(0, size);
  const chunks = Array.from({ length: Math.ceil(source.length / 4) }, (_, index) =>
    source.slice(index * 4, index * 4 + 4),
  );
  const run = () => {
    const stream = createAssistantVisibleStreamText("final_answer");
    let replacements = 0;
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (const chunk of chunks) {
      replacements += Number(stream.append(chunk).delta === null);
    }
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    assert.equal(stream.text, source.trimEnd());
    return { elapsedMs, cpuMs: (used.user + used.system) / 1000, replacements };
  };
  return {
    shape,
    sourceCharacters: source.length,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    chunks: chunks.length,
    cold: run(),
    warm: run(),
  };
});
console.log(
  JSON.stringify({
    node: process.version,
    loadAverage: loadavg(),
    cases,
    maxRssKiB: process.resourceUsage().maxRSS,
    parity: true,
  }),
);
