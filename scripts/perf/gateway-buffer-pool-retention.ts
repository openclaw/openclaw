// Run on each revision with node --import ./scripts/tsx.mjs.
// Sparse publications interleave disposable allocations; holders stay live through reporting.
import assert from "node:assert/strict";
import {
  registerSerializedJsonArray,
  serializeGatewayFrame,
  SerializedGatewayFrame,
  SerializedJsonPayload,
} from "../../src/gateway/serialized-json.js";
const slabBytes = Buffer.from("marker").buffer.byteLength;
const churn = "x".repeat(Buffer.poolSize / 2 - 8);
function between() {
  for (let i = 0; i < 3; i++) {
    Buffer.from(churn);
  }
}
function report(site: string, buffers: Uint8Array[]) {
  const stores = new Set(buffers.map((b) => b.buffer));
  console.log(
    JSON.stringify({
      site,
      holders: buffers.length,
      poolSize: Buffer.poolSize,
      slabBytes,
      payloadBytes: buffers.reduce((n, b) => n + b.byteLength, 0),
      backingBytes: [...stores].reduce((n, b) => n + b.byteLength, 0),
      pooledStores: [...stores].filter((b) => b.byteLength === slabBytes).length,
    }),
  );
}
const registered = [];
const encoded = [];
for (let i = 0; i < 70; i++) {
  between();
  const rows = Array.from({ length: 10 }, (_, j) => ({ key: `session-${i}-${j}`, label: "雪🦞" }));
  registerSerializedJsonArray(
    rows,
    rows.map((row) => JSON.stringify(row)),
  );
  registered.push(rows);
  const frame = serializeGatewayFrame({ type: "res", payload: { rows } });
  assert(frame instanceof SerializedGatewayFrame);
  const bytes = frame.segments.find(
    (segment) =>
      Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength).toString() ===
      JSON.stringify(rows),
  );
  assert(bytes);
  encoded.push(bytes);
  assert.equal(frame.toString(), JSON.stringify({ type: "res", payload: { rows } }));
}
report("registered-arrays", encoded);
for (const segmented of [false, true]) {
  const payloads = [];
  for (let i = 0; i < 16; i++) {
    between();
    const rows = [{ label: "雪🦞", i }];
    if (segmented) {
      registerSerializedJsonArray(
        rows,
        rows.map((row) => JSON.stringify(row)),
      );
    }
    const payload = { rows };
    const prepared = new SerializedJsonPayload(payload);
    assert.deepEqual(prepared.toJSON(), payload);
    payloads.push(prepared.bytes);
  }
  report(segmented ? "shared-payload-segmented" : "shared-payload-string", payloads);
}
assert.equal(registered.length, 70);
