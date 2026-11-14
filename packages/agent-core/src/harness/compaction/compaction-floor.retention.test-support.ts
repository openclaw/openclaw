import assert from "node:assert/strict";
import { prepareCompactionFloorMessage } from "./compaction-floor.js";

const gc = global.gc;
assert.ok(gc, "retention probe requires --expose-gc");
gc();
gc();
const before = process.memoryUsage().heapUsed;
const facts = Array.from({ length: 4096 }, (_, index) =>
  prepareCompactionFloorMessage({
    role: "user",
    content: Buffer.alloc(15_000, 65 + (index % 20)).toString(),
    timestamp: index,
  }),
);
gc();
gc();
const retainedBytes = process.memoryUsage().heapUsed - before;
console.log(JSON.stringify({ retainedBytes, donorBytes: facts.length * 15_000 }));
assert.ok(
  retainedBytes < 12 * 1024 * 1024,
  `bounded floor facts retained ${retainedBytes} bytes from discarded transcript payloads`,
);
// Inspect text only after measuring; assertions must not flatten donor-backed strings.
assert.equal(facts[0]?.user?.text.length, 1_000);
assert.equal(facts[0]?.user?.text, `${"A".repeat(994)} [...]`);
