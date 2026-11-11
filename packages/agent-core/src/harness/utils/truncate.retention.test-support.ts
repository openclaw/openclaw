import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { truncateHead } from "./truncate.js";

const [rawLimit] = process.argv.slice(2);
const limit = Number(rawLimit);
assert.ok(limit === 64 || limit === 4096);
const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const inputUnits = 2 * 1024 * 1024;

function makeResults() {
  const results = [];
  for (let index = 0; index < 8; index++) {
    const bytes = Buffer.alloc(inputUnits * 2);
    bytes.fill(Buffer.from([65 + index, 0]));
    bytes.writeUInt16LE(10, limit * 2);
    const input = bytes.toString("utf16le");
    results.push(truncateHead(input, limit));
  }
  return results;
}

const collect = async () => {
  for (let pass = 0; pass < 3; pass++) {
    await setImmediate();
    gc();
  }
  return process.memoryUsage();
};

const before = await collect();
const results = makeResults();
const held = await collect();
// Reading or serializing a returned string can flatten it and hide source retention.
for (const [index, result] of results.entries()) {
  const content = String.fromCharCode(65 + index).repeat(limit);
  assert.deepEqual(result, {
    content,
    truncated: true,
    truncatedBy: "bytes",
    totalLines: 2,
    totalBytes: inputUnits,
    outputLines: 1,
    outputBytes: limit,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 2000,
    maxBytes: limit,
  });
}
process.stdout.write(
  JSON.stringify({
    heapUsedIncrease: held.heapUsed - before.heapUsed,
    externalIncrease: held.external - before.external,
    results,
  }),
);
