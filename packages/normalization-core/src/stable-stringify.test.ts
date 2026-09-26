/**
 * Regression coverage for deterministic unknown-value stringification.
 * Verifies sorted keys, repeated references, cycles, binary data, and errors.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex, sha256StableValue } from "./node-crypto.js";
import { stableStringify, writeStableStringify } from "./stable-stringify.js";

const sanitizeSurrogates = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

const serializers: Record<string, typeof stableStringify> = {
  stableStringify,
  writeStableStringify: (value, normalizeString) => {
    const chunks: string[] = [];
    writeStableStringify(value, (chunk) => chunks.push(chunk), normalizeString);
    return chunks.join("");
  },
};

describe.each(Object.entries(serializers))("%s", (_name, serialize) => {
  it.each([
    ['{"z":1,"a":2}', '{"a":2,"z":1}'],
    [
      '{"items":[3,null,{"z":false,"a":1.5}],"enabled":true}',
      '{"enabled":true,"items":[3,null,{"a":1.5,"z":false}]}',
    ],
    ['["text",0,-2.5,null,false]', '["text",0,-2.5,null,false]'],
  ])("preserves deterministic bytes for parsed JSON %#", (json, expected) => {
    expect(serialize(JSON.parse(json))).toBe(expected);
  });

  it("sorts object keys recursively", () => {
    expect(serialize({ b: { d: 4, c: 3 }, a: 1 })).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  it("marks true circular references without collapsing repeated references", () => {
    const shared = { value: 1 };
    const root: Record<string, unknown> = { first: shared, second: shared };
    root.self = root;

    expect(serialize(root)).toBe('{"first":{"value":1},"second":{"value":1},"self":"[Circular]"}');
  });

  it("handles circular arrays without treating later siblings as circular", () => {
    const shared = { value: "same" };
    const items: unknown[] = [shared, shared];
    items.push(items);

    expect(serialize(items)).toBe('[{"value":"same"},{"value":"same"},"[Circular]"]');
  });

  it("opts into string normalization without changing the lossless default", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);
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

  it("sorts normalized keys before serializing them", () => {
    const high = String.fromCharCode(0xd83d);
    const malformed = { ba: 2, [`b${high}`]: 1 };
    const normalized = { ba: 2, b: 1 };

    expect(serialize(malformed, sanitizeSurrogates)).toBe(
      serialize(normalized, sanitizeSurrogates),
    );
    expect(serialize(malformed, sanitizeSurrogates)).toBe('{"b":1,"ba":2}');
  });

  it("serializes Date instances to ISO 8601 strings and handles Invalid Date", () => {
    const validDate = new Date("2026-01-01T00:00:00.000Z");
    const invalidDate = new Date(Number.NaN);
    expect(stableStringify(validDate)).toBe('"2026-01-01T00:00:00.000Z"');
    expect(stableStringify(invalidDate)).toBe("null");
    expect(stableStringify({ date: validDate })).toBe('{"date":"2026-01-01T00:00:00.000Z"}');
    expect(stableStringify({ date: invalidDate })).toBe('{"date":null}');
  });

  it("serializes RegExp, Set, and Map collections deterministically", () => {
    expect(stableStringify(/abc/gi)).toBe('"/abc/gi"');

    const set1 = new Set([3, 1, 2]);
    const set2 = new Set([1, 2, 3]);
    expect(stableStringify(set1)).toBe("[1,2,3]");
    expect(stableStringify(set1)).toBe(stableStringify(set2));

    const map = new Map<unknown, unknown>([
      [1, "number-one"],
      ["1", "string-one"],
      ["z", 2],
      ["a", 1],
    ]);
    expect(stableStringify(map)).toBe('[["1","string-one"],["a",1],["z",2],[1,"number-one"]]');
  });

  it("serializes cache-trace edge types deterministically", () => {
    const error = new Error("boom");
    error.stack = "Error: boom\n    at test";

    expect(
      serialize({
        bytes: new Uint8Array([1, 2, 3]),
        date: new Date("2026-01-01T00:00:00.000Z"),
        error,
        finite: 1,
        infinity: Infinity,
        nan: Number.NaN,
        nil: null,
        token: 123n,
        undef: undefined,
      }),
    ).toBe(
      '{"bytes":{"data":"AQID","type":"Uint8Array"},"date":"2026-01-01T00:00:00.000Z","error":{"message":"boom","name":"Error","stack":"Error: boom\\n    at test"},"finite":1,"infinity":"Infinity","nan":"NaN","nil":null,"token":"123","undef":undefined}',
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
    expect(
      serialize(value, (text) => {
        observations.push(`normalize:${text}`);
        return text.toLowerCase();
      }),
    ).toBe('{"b":"upper","b":"lower"}');
    expect(observations).toEqual([
      "normalize:b",
      "normalize:B",
      "get:B",
      "normalize:upper",
      "get:b",
      "normalize:lower",
    ]);
  });
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
