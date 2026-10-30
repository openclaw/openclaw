// Native Node owner benchmark (no build or Gateway required):
// node --expose-gc scripts/perf/telegram-entity-sort-measure.mjs --mode timing
// Repeat with --mode allocation; never compare timings from the sampled pass.
// For a base revision, save its inbound-text-entities.ts with git show and pass
// --owner-file <absolute-path>. Run base/candidate in alternating launch order.
// Synthetic formatted inbound messages span 8/32/64 lines; this measures the
// renderer's cost per message, not whole-Gateway throughput or production mix.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "6000" },
    "owner-file": { type: "string" },
  },
});
assert(["timing", "allocation"].includes(values.mode));
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = values["owner-file"]
  ? pathToFileURL(resolve(values["owner-file"]))
  : new URL("../../extensions/telegram/src/bot/inbound-text-entities.ts", import.meta.url);
const { renderTelegramTextEntities: render } = await import(owner.href);
const line = "A synthetic quoted update with bold and italic text.\n";
const fixtures = [8, 32, 64].map((lines) => {
  const text = line.repeat(lines);
  const entities = [];
  for (let index = 0; index < lines; index++) {
    const offset = index * line.length;
    entities.push(
      { type: "italic", offset: offset + 40, length: 6 },
      { type: "bold", offset: offset + 31, length: 4 },
    );
    if (index % 4 === 0) {
      entities.push({ type: "blockquote", offset, length: line.length - 1 });
    }
  }
  return {
    text,
    entities: Object.freeze(entities.map((entity) => Object.freeze(entity))),
    expected: Array.from(
      { length: lines },
      (_, index) =>
        `${index % 4 === 0 ? "> " : ""}A synthetic quoted update with **bold** and _italic_ text.\n${index % 4 === 0 ? "\n" : ""}`,
    ).join(""),
  };
});
for (const fixture of fixtures) {
  assert.equal(render(fixture.text, fixture.entities), fixture.expected);
}
let outputChars = 0;
function run(count) {
  for (let index = 0; index < count; index++) {
    const { text, entities } = fixtures[index % fixtures.length];
    outputChars += render(text, entities).length;
  }
}
run(1500);
outputChars = 0;
globalThis.gc?.();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 16384,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();
run(iterations);
const wallMs = performance.now() - wallStart;
const cpu = process.cpuUsage(cpuStart);
let allocation;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  allocation = {
    sampledBytesPerMessage:
      profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations,
    samples: profile.samples.length,
  };
}
console.log(
  JSON.stringify({
    mode: values.mode,
    node: process.version,
    iterations,
    fixtures: fixtures.map(({ text, entities }) => ({
      chars: text.length,
      entities: entities.length,
    })),
    hostLoad,
    wallMs,
    cpuUsPerMessage: (cpu.user + cpu.system) / iterations,
    allocation,
    outputChars,
  }),
);
