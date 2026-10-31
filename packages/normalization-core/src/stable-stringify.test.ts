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

it.each<[unknown, string]>([
  [
    { items: [3, null, { z: false, a: 1.5 }], enabled: true },
    '{"enabled":true,"items":[3,null,{"a":1.5,"z":false}]}',
  ],
  [
    { z: undefined, a: [undefined, ...Array<undefined>(1), null] },
    '{"a":[undefined,undefined,null],"z":undefined}',
  ],
  [{ "2": "two", "10": "ten", "": {} }, '{"":{},"10":"ten","2":"two"}'],
  [[true, false, 0, -0, 1e21, 1e-7, [], {}], "[true,false,0,0,1e+21,1e-7,[],{}]"],
  ['"\\\n\t🦞\ud800', '"\\"\\\\\\n\\t🦞\\ud800"'],
  [undefined, "undefined"],
  [null, "null"],
])("pins existing JSON and undefined bytes for fixture %#", (value, expected) => {
  expect(stableStringify(value)).toBe(expected);
  expect(serialize(value)).toBe(expected);
  expect(sha256StableValue(value).digest).toBe(sha256Hex(expected));
});

it("handles circular arrays without treating later siblings as circular", () => {
  const shared = { value: "same" };
  const items: unknown[] = [shared, shared];
  items.push(items);

  expect(serialize(items)).toBe('[{"value":"same"},{"value":"same"},"[Circular]"]');
});

it("pins typed encodings, collection ordering and cycles in both output paths", () => {
  const set = new Set<unknown>(["z\ud800", "a"]);
  set.add(set);
  const map = new Map<unknown, unknown>([
    [1, "number"],
    ["1", "string"],
  ]);
  map.set("self", map);
  const value = {
    set,
    map,
    date: new Date("2026-01-01Z"),
    invalid: new Date(Number.NaN),
    regex: /a/gi,
  };
  const expected =
    '{"date":Date("2026-01-01T00:00:00.000Z"),"invalid":Date(null),"map":Map([["1","string"],["self","[Circular]"],[1,"number"]]),"regex":RegExp("/a/gi"),"set":Set(["[Circular]","a","z\\ud800"])}';
  expect(stableStringify(value)).toBe(expected);
  expect(serialize(value)).toBe(expected);
  expect(sha256StableValue(value).digest).toBe(sha256Hex(expected));
  expect(serialize(set, sanitizeSurrogates)).toBe('Set(["[Circular]","a","z"])');
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
