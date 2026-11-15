// Fixed owner workloads; run serially on base/head with node --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { mock } from "node:test";
import { createAssistantVisibleStreamText } from "../src/agents/embedded-agent-utils.js";

const cases = [128, 0, 32, 64].map((count) => {
  const paragraphs = count || 128;
  const opening = "The service is ready.";
  const tail = Array.from(
    { length: paragraphs },
    (_, index) =>
      `Paragraph ${String(index).padStart(4, "0")}: this service returns an ordinary explanatory sentence without code.`,
  );
  const source = [opening, count ? opening : "A different opening.", ...tail].join("\n\n");
  const expected = [opening, ...(count ? [] : ["A different opening."]), ...tail].join("\n\n");
  const chunks = Array.from({ length: Math.ceil(source.length / 4) }, (_, index) =>
    source.slice(index * 4, index * 4 + 4),
  );
  const run = () => {
    const stream = createAssistantVisibleStreamText("final_answer");
    let delivered = "";
    let replacements = 0;
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    for (const chunk of chunks) {
      const result = stream.append(chunk);
      replacements += Number(result.delta === null);
      delivered = result.delta === null ? result.text : delivered + result.delta;
      assert.equal(delivered, result.text);
    }
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    assert.equal(stream.text, expected);
    return { elapsedMs, cpuMs: (used.user + used.system) / 1000, replacements };
  };
  const cold = run();
  run();
  const warm = run();
  const measureScan = () => {
    let scannedCharacters = 0;
    const probe = mock.method(String.prototype, "matchAll");
    try {
      run();
      for (const call of probe.mock.calls) {
        if (call.arguments[0].source === "\\n+|[^\\n]+") {
          scannedCharacters += String(call.this).length;
        }
      }
    } finally {
      probe.mock.restore();
    }
    return scannedCharacters;
  };
  return {
    paragraphs,
    control: !count,
    sourceCharacters: source.length,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    chunks: chunks.length,
    measureScan,
    cold,
    warm,
  };
});
const maxRssKiB = process.resourceUsage().maxRSS;
const measuredCases = cases.map(({ measureScan, ...entry }) =>
  Object.assign(entry, { scannedCharacters: measureScan() }),
);
console.log(
  JSON.stringify({
    node: process.version,
    loadAverage: loadavg(),
    cases: measuredCases,
    maxRssKiB,
    parity: true,
  }),
);
