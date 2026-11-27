# Reproducible catalogue design arithmetic

**Design calculation: DONE. Accepted product behavior: NOT COLLECTED. Runtime performance: UNMEASURED.**

This is the complete standalone synthetic script executed for this iteration with Node v24.22.3. It imports no project code, reads no user data or credentials, and uses no network. Its output is [catalogue-size-calculation.json](catalogue-size-calculation.json). The raw temporary .mjs is not a maintained repository command; its source is preserved here as documentation. No runtime feature was implemented.

The candidate shape, identifier alphabet and at-most-eight-byte true-to-false reserve are proposals. Escaping/control fixtures establish byte bounds, not accepted trigger grammar. To reproduce later in a separately permitted temporary directory, save the code below as catalogue-size-calculation.mjs and run it once with Node. It refuses to overwrite the numeric report.

## Complete calculation source

```javascript
// Design arithmetic only. No repository imports, user data, network, or product execution.
import { writeFileSync } from "node:fs";

const startedAtUtc = new Date().toISOString();
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const envelope = (entries) => ({ version: 1, entries });
const maximal = (body = "A".repeat(256), triggerFor = (i) => `trigger${i}`.padEnd(64, "a")) =>
  envelope(
    Array.from({ length: 8 }, (_, i) => ({
      id: `s${i + 1}`.padEnd(16, "a"),
      trigger: triggerFor(i + 1),
      body,
      enabled: true,
    })),
  );
const withQuotes = (count, enabled = true) => {
  const value = maximal();
  for (const entry of value.entries) {
    const quotes = Math.min(count, 256);
    entry.body = '"'.repeat(quotes) + "A".repeat(256 - quotes);
    entry.enabled = enabled;
    count -= quotes;
  }
  if (count !== 0) throw new Error("Synthetic quote budget exceeds fixture capacity");
  return value;
};
const cases = [
  ["empty", envelope([])],
  [
    "representative-one",
    envelope([{ id: "s1", trigger: "status", body: "Build complete.", enabled: true }]),
  ],
  [
    "representative-eight",
    envelope(
      Array.from({ length: 8 }, (_, i) => ({
        id: `s${i + 1}`,
        trigger: `status ${i + 1}`,
        body: "Build complete.",
        enabled: true,
      })),
    ),
  ],
  ["max-ascii", maximal()],
  ["max-multibyte", maximal("😀".repeat(64), (i) => "界".repeat(21) + i)],
  ["ordinary-trigger-escaped-body", maximal('"\\'.repeat(128))],
  ["escaped-trigger-and-body", maximal('"\\'.repeat(128), () => '"\\'.repeat(32))],
  ["ordinary-trigger-linefeeds", maximal("\n".repeat(256))],
  ["ordinary-trigger-control-body", maximal("\u0000".repeat(256))],
  ["control-trigger-and-body", maximal("\u0000".repeat(256), () => "\u0000".repeat(64))],
  ["actual-4096", withQuotes(999)],
  ["actual-4097", withQuotes(1000)],
  ["projected-4096", withQuotes(991)],
  ["projected-4097", withQuotes(992)],
  ["all-false-4096", withQuotes(991, false)],
];
const measurements = cases.map(([id, value]) => {
  const actualBytes = bytes(value);
  const allFalse = {
    ...value,
    entries: value.entries.map((entry) => ({ ...entry, enabled: false })),
  };
  const trueCount = value.entries.filter((entry) => entry.enabled).length;
  const allFalseBytes = bytes(allFalse);
  if (actualBytes + trueCount !== allFalseBytes)
    throw new Error("Boolean byte decomposition mismatch");
  return {
    id,
    records: value.entries.length,
    actualBytes,
    trueCount,
    allFalseBytes,
    reservedHeadroom: 4096 - allFalseBytes,
    withinGenericCeilingByArithmetic: actualBytes <= 4096,
    withinProposedReserveByArithmetic: allFalseBytes <= 4096,
    rawFieldCapsMet: value.entries.every(
      (entry) =>
        /^[A-Za-z0-9_-]{1,16}$/.test(entry.id) &&
        Buffer.byteLength(entry.trigger, "utf8") <= 64 &&
        Buffer.byteLength(entry.body, "utf8") <= 256,
    ),
    productAcceptance: "NOT COLLECTED; grammar/content policy not evaluated",
  };
});
const report = {
  scope: "TRUSTED STANDALONE DESIGN ARITHMETIC; NOT PRODUCT TESTS OR A BENCHMARK",
  command: "node checks/catalogue-size-calculation.mjs",
  startedAtUtc,
  completedAtUtc: new Date().toISOString(),
  runtime: process.version,
  sourceMain: "aa8288706247f3445242abf74395b9419100e665",
  actualPreferenceKey: null,
  shape: "version:1, entries:[{id,trigger,body,enabled}]",
  limits: {
    entries: 8,
    idAscii: 16,
    triggerUtf8: 64,
    bodyUtf8: 256,
    serializedValueUtf8: 4096,
    profileKeys: 128,
    updateEntries: 32,
  },
  proposedReserve: "actual compact JSON UTF-8 bytes + number of true enabled flags <= 4096",
  existingGatewayRule:
    "Complete serialized value <= 4096; no boolean reserve imposed by generic Gateway validation",
  inputs:
    "Synthetic literals only; unusual/control trigger stress does not claim product-valid grammar",
  timingEvidence: "UNMEASURED; execution timestamps are not application latency",
  runtimeProof: "NOT COLLECTED",
  measurements,
};
writeFileSync(
  new URL("catalogue-size-calculation.json", import.meta.url),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify(
    {
      completedAtUtc: report.completedAtUtc,
      runtime: report.runtime,
      measurements: measurements.map(({ id, actualBytes, allFalseBytes }) => ({
        id,
        actualBytes,
        allFalseBytes,
      })),
    },
    null,
    2,
  ),
);
```
