import { expect, it } from "vitest";
import { sha256Hex, sha256StableValue } from "./node-crypto.js";
import { stableStringify, writeStableStringify } from "./stable-stringify.js";

const sanitizeSurrogates = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

const serialize = (value: unknown, normalizeString?: (text: string) => string): string => {
  const chunks: string[] = [];
  writeStableStringify(value, (chunk) => chunks.push(chunk), normalizeString);
  return chunks.join("");
};

it("preserves parsed JSON values and sorts keys recursively", () => {
  const value = JSON.parse('{"items":[3,null,{"z":false,"a":1.5}],"enabled":true}');
  expect(stableStringify(value)).toBe('{"enabled":true,"items":[3,null,{"a":1.5,"z":false}]}');
});

it("handles circular arrays without treating later siblings as circular", () => {
  const shared = { value: "same" };
  const items: unknown[] = [shared, shared];
  items.push(items);

  expect(serialize(items)).toBe('[{"value":"same"},{"value":"same"},"[Circular]"]');
});

it("opts into string normalization without changing the lossless default", () => {
  const value = {
    "key\ud83d": "name",
    high: "left\ud83dright",
    low: "left\udc00right",
    valid: "emoji 🙈 ok",
  };

  expect(serialize(value)).toBe(
    '{"high":"left\\ud83dright","key\\ud83d":"name","low":"left\\udc00right","valid":"emoji 🙈 ok"}',
  );
  const normalized = '{"high":"leftright","key":"name","low":"leftright","valid":"emoji 🙈 ok"}';
  expect(serialize(value, sanitizeSurrogates)).toBe(normalized);
  expect(sha256StableValue(value, sanitizeSurrogates)).toEqual({
    digest: sha256Hex(normalized),
    byteWeight: Buffer.byteLength(normalized),
  });
});

const error = Object.assign(new Error("boom"), { stack: "Error: boom\n    at test" });
it.each<[unknown, string]>([
  [new Uint8Array([1, 2, 3]), '{"data":"AQID","type":"Uint8Array"}'],
  [error, '{"message":"boom","name":"Error","stack":"Error: boom\\n    at test"}'],
  [1, "1"],
  [Infinity, '"Infinity"'],
  [Number.NaN, '"NaN"'],
  [null, "null"],
  [123n, '"123"'],
  [undefined, "undefined"],
])("serializes nested cache-trace case %#", (value, expected) => {
  expect(serialize({ value })).toBe(`{"value":${expected}}`);
});

it("preserves colliding normalized keys and reads getters in deterministic order", () => {
  const observations: string[] = [];
  const value = {
    get b() {
      observations.push("get:b");
      return "lower";
    },
    get B() {
      observations.push("get:B");
      return "upper";
    },
  };
  const serialized = serialize(value, (text) => {
    observations.push(`normalize:${text}`);
    return text.toLowerCase();
  });
  expect(serialized).toBe('{"b":"upper","b":"lower"}');
  expect(observations).toEqual(
    "normalize:b normalize:B get:B normalize:upper get:b normalize:lower".split(" "),
  );
});

it.each([1, 20_000])("hashes and counts complete Unicode text with %i repetitions", (count) => {
  const text = "🦞日本語\ud800".repeat(count);
  const value = { z: [text, undefined], a: text };
  const quoted = JSON.stringify(text);
  const expected = `{"a":${quoted},"z":[${quoted},undefined]}`;
  expect(sha256StableValue(value)).toEqual({
    digest: sha256Hex(expected),
    byteWeight: Buffer.byteLength(expected),
  });
});
