import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("werift"));
const { BinaryStream, createDecode, decode, encode, types } = require("@shinyoshiaki/binary-data");

const cases = [
  ["doublebe", "DoubleBE", 8, -Math.PI],
  ["doublele", "DoubleLE", 8, Math.PI],
  ["floatbe", "FloatBE", 4, -1.25],
  ["floatle", "FloatLE", 4, 1.25],
  ["int8", "Int8", 1, -127],
  ["uint8", "UInt8", 1, 255],
  ["int16be", "Int16BE", 2, -32767],
  ["int16le", "Int16LE", 2, -32767],
  ["uint16be", "UInt16BE", 2, 65535],
  ["uint16le", "UInt16LE", 2, 65535],
  ["int32be", "Int32BE", 4, -2147483647],
  ["int32le", "Int32LE", 4, -2147483647],
  ["uint32be", "UInt32BE", 4, 4294967295],
  ["uint32le", "UInt32LE", 4, 4294967295],
  ["int24be", "IntBE", 3, -8388607],
  ["int24le", "IntLE", 3, -8388607],
  ["uint24be", "UIntBE", 3, 16777215],
  ["uint24le", "UIntLE", 3, 16777215],
  ["int40be", "IntBE", 5, -549755813887],
  ["int40le", "IntLE", 5, -549755813887],
  ["uint40be", "UIntBE", 5, 1099511627775],
  ["uint40le", "UIntLE", 5, 1099511627775],
  ["int48be", "IntBE", 6, -140737488355327],
  ["int48le", "IntLE", 6, -140737488355327],
  ["uint48be", "UIntBE", 6, 281474976710655],
  ["uint48le", "UIntLE", 6, 281474976710655],
];
const schema = {};
const input = {};
const expectedChunks = [];
for (const [name, suffix, size, value] of cases) {
  schema[name] = types[name];
  input[name] = value;
  const expected = Buffer.alloc(size);
  if ([3, 5, 6].includes(size)) {
    expected[`write${suffix}`](value, 0, size);
  } else {
    expected[`write${suffix}`](value, 0);
  }
  expectedChunks.push(expected);
  const encoded = encode(value, types[name]);
  assert.deepEqual(encoded.slice(), expected, name);
  assert.equal(encode.bytes, size, name);
  assert.equal(decode(expected, types[name]), value, name);
  assert.equal(decode.bytes, size, name);
  const fragmented = new BinaryStream();
  for (const byte of expected) {
    fragmented.append(Buffer.from([byte]));
  }
  assert.equal(decode(fragmented, types[name]), value, name);
  assert.equal(fragmented.length, 0, name);
}
const expected = Buffer.concat(expectedChunks);
assert.deepEqual(encode(input, schema).slice(), expected);
assert.deepEqual({ ...decode(expected, schema) }, input);
const decoder = createDecode(schema);
const values = [];
decoder.on("data", (value) => values.push({ ...value }));
for (const byte of Buffer.concat([expected, expected])) {
  decoder.write(Buffer.from([byte]));
}
decoder.end();
assert.deepEqual(values, [input, input]);
console.log(
  "all numeric codecs: bytes, endian, fragmented reads and transactional decoding passed",
);
