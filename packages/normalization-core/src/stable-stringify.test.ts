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
  const high = "\ud83d";
  const low = "\udc00";
  const value = {
    [`key${high}`]: "name",
    high: `left${high}right`,
    low: `left${low}right`,
    valid: "emoji 🙈 ok",
  };

  expect(serialize(value)).toBe(
    '{"high":"left\\ud83dright","key\\ud83d":"name","low":"left\\udc00right","valid":"emoji 🙈 ok"}',
  );
  expect(serialize(value, sanitizeSurrogates)).toBe(
    '{"high":"leftright","key":"name","low":"leftright","valid":"emoji 🙈 ok"}',
  );
});

it("serializes cache-trace edge types deterministically", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at test";

  const value = {
    bytes: new Uint8Array([1, 2, 3]),
    error,
    finite: 1,
    infinity: Infinity,
    nan: Number.NaN,
    nil: null,
    token: 123n,
    undef: undefined,
  };
  expect(serialize(value)).toBe(
    '{"bytes":{"data":"AQID","type":"Uint8Array"},"error":{"message":"boom","name":"Error","stack":"Error: boom\\n    at test"},"finite":1,"infinity":"Infinity","nan":"NaN","nil":null,"token":"123","undef":undefined}',
  );
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
