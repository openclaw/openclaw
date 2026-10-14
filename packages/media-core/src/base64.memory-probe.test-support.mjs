import assert from "node:assert/strict";
import { getHeapStatistics } from "node:v8";
import { canonicalizeBase64 } from "./base64.ts";

const kind = process.argv[2];
assert.ok(kind === "canonical" || kind === "shredded");
const encoded = Buffer.alloc((kind === "canonical" ? 16 : 2) * 1024 * 1024, 0xab).toString(
  "base64",
);
const input =
  kind === "canonical"
    ? encoded
    : "q\n6\nu\nr\n".repeat(Math.floor((2 * 1024 * 1024) / 3)) + "q\n6\ns\n=";

function usedMemoryBytes() {
  const { used_heap_size, external_memory } = getHeapStatistics();
  return used_heap_size + external_memory;
}

// Each case owns its VM; collection cannot charge another test's strings.
const beforeVm = usedMemoryBytes();
const actual = canonicalizeBase64(input);
const vmDelta = usedMemoryBytes() - beforeVm;
// Equality and serialization can flatten strings, so keep them outside the samples.
assert.equal(actual, encoded);
process.stdout.write(JSON.stringify({ vmDelta }));
