import assert from "node:assert/strict";
// Resolve the real dependency owner without adding a test-only package export.
const entry = import.meta.resolve("@openclaw/crabline");
const { encodeFeishuFrame, decodeFeishuFrame, feishuHeader } = await import(
  new URL("./servers/feishu-wire.js", entry).href
);

const frame = {
  SeqID: "18446744073709551615",
  LogID: "9007199254740993",
  service: -7,
  method: 1,
  headers: [
    { key: "type", value: "event" },
    { key: "locale", value: "日本語" },
  ],
  payloadEncoding: "json",
  payloadType: "event",
  payload: Buffer.from([0, 1, 127, 128, 255]),
  LogIDNew: "log-42",
};
const expectedHex =
  "08ffffffffffffffffff0110818080808080801018f9ffffffffffffffff0120012a0d0a047479706512056576656e742a130a066c6f63616c651209e697a5e69cace8aa9e32046a736f6e3a056576656e74420500017f80ff4a066c6f672d3432";
const bytes = encodeFeishuFrame(frame);
assert.equal(Buffer.from(bytes).toString("hex"), expectedHex);
assert.deepEqual(decodeFeishuFrame(bytes), frame);
assert.equal(feishuHeader(frame, "type"), "event");
assert.equal(feishuHeader(frame, "missing"), undefined);
assert.deepEqual(decodeFeishuFrame(Buffer.concat([bytes, Buffer.from([0xf8, 7, 1])])), frame);
assert.deepEqual(decodeFeishuFrame(Buffer.from("0800100018002000", "hex")), {
  SeqID: "0",
  LogID: "0",
  service: 0,
  method: 0,
  headers: [],
});
assert.throws(() => decodeFeishuFrame(Buffer.from("0801", "hex")), /missing required 'LogID'/u);
assert.throws(() => decodeFeishuFrame(Buffer.from("0880", "hex")), /index out of range/u);
for (const id of ["", "-1", "01", "18446744073709551616"]) {
  assert.throws(() => encodeFeishuFrame({ ...frame, SeqID: id }), /uint64 decimal strings/u);
  assert.throws(() => encodeFeishuFrame({ ...frame, LogID: id }), /uint64 decimal strings/u);
}
console.log("Feishu protobuf wire fixtures passed");
