import { getHeapStatistics } from "node:v8";
import { describe, expect, it } from "vitest";
import { canonicalizeBase64, estimateBase64DecodedBytes, isValidBase64 } from "./base64.js";

function usedMemoryBytes(): number {
  // Bun's process.memoryUsage().heapUsed is sampled at the last collection.
  const { used_heap_size, external_memory } = getHeapStatistics();
  return used_heap_size + external_memory;
}

describe("base64 helpers", () => {
  it("canonicalizeBase64 validates large payloads without cons-string overflow", () => {
    const encoded = Buffer.alloc(1_900_000).toString("base64");

    expect(canonicalizeBase64(encoded)).toBe(encoded);
  });

  it("canonicalizeBase64 handles attachment-sized payloads without heap blow-up", () => {
    // Regression guard: the previous per-character append built one cons-string
    // node per input character (~25 bytes each, all live at once), so this
    // 16 MiB payload (21.3 M base64 chars) transiently needed >500 MB of heap.
    // The threshold is deliberately generous; the bounded-buffer implementation
    // returns already-canonical input unchanged.
    const encoded = Buffer.alloc(16 * 1024 * 1024, 0xab).toString("base64");
    const before = usedMemoryBytes();
    const actual = canonicalizeBase64(encoded);
    const delta = usedMemoryBytes() - before;
    expect(actual).toBe(encoded);
    expect(delta).toBeLessThan(100 * 1024 * 1024);
  });

  it("canonicalizeBase64 cleans whitespace inside large payloads", () => {
    const encoded = Buffer.alloc(1_000_000, 0xab).toString("base64");
    const wrapped = encoded.replace(/(.{76})/g, "$1\r\n");

    expect(canonicalizeBase64(wrapped)).toBe(encoded);
  });

  it("canonicalizeBase64 handles one whitespace per character without heap blow-up", () => {
    // Keep the same coarse memory budget when every data character is its own
    // whitespace-delimited run (2.7 M runs here).
    const encoded = Buffer.alloc(2 * 1024 * 1024, 0xab).toString("base64");
    // Repeat the 0xab encoding without leaving a multi-million-entry split array for GC.
    const shredded = "q\n6\nu\nr\n".repeat(Math.floor((2 * 1024 * 1024) / 3)) + "q\n6\ns\n=";
    const before = usedMemoryBytes();
    const actual = canonicalizeBase64(shredded);
    const delta = usedMemoryBytes() - before;
    expect(actual).toBe(encoded);
    expect(delta).toBeLessThan(64 * 1024 * 1024);
  });

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  it("base64 helpers accept the full standard alphabet", () => {
    expect(canonicalizeBase64(alphabet)).toBe(alphabet);
    expect(isValidBase64(alphabet)).toBe(true);
  });

  it.each(["*", ",", ".", ":", "@", "[", "`", "{", "-", "_", "\u007f", "é", "\ud800", "\udc00"])(
    "base64 helpers reject non-alphabet glyph %j",
    (glyph) => {
      expect(canonicalizeBase64("AA" + glyph + "A")).toBeUndefined();
      expect(isValidBase64("AA" + glyph + "A")).toBe(false);
    },
  );

  it.each(Array.from(alphabet))(
    "canonicalizeBase64 validates terminal pad bits for %s",
    (glyph) => {
      const paddedByte = `A${glyph}==`;
      const paddedPair = `AA${glyph}=`;

      expect(canonicalizeBase64(paddedByte)).toBe("AQgw".includes(glyph) ? paddedByte : undefined);
      expect(canonicalizeBase64("A" + glyph)).toBe("AQgw".includes(glyph) ? paddedByte : undefined);
      expect(canonicalizeBase64(paddedPair)).toBe(
        "AEIMQUYcgkosw048".includes(glyph) ? paddedPair : undefined,
      );
      expect(canonicalizeBase64("AA" + glyph)).toBe(
        "AEIMQUYcgkosw048".includes(glyph) ? paddedPair : undefined,
      );
    },
  );

  it.each([
    {
      name: "canonicalizeBase64 normalizes whitespace and keeps valid base64",
      actual: canonicalizeBase64(" SGV s bG8= \n"),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 pads valid unpadded base64",
      actual: canonicalizeBase64("SGVsbG8"),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 rejects impossible unpadded length",
      actual: canonicalizeBase64("S"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects invalid base64 characters",
      actual: canonicalizeBase64('SGVsbG8=" onerror="alert(1)'),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects nonzero pad bits",
      actual: canonicalizeBase64("ZE=="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects nonzero pad bits on auto-padded input",
      actual: canonicalizeBase64("ZE"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 trims leading and trailing whitespace",
      actual: canonicalizeBase64("\n\tSGVsbG8=  "),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 rejects data chars after padding",
      actual: canonicalizeBase64("QQ==QQ=="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects more than two padding chars",
      actual: canonicalizeBase64("===="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects a data: URL prefix",
      actual: canonicalizeBase64("data:image/png;base64,QUJD"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects whitespace-only input",
      actual: canonicalizeBase64(" \r\n\t"),
      expected: undefined,
    },
    {
      name: "estimateBase64DecodedBytes handles whitespace",
      actual: estimateBase64DecodedBytes("SGV s bG8= \n"),
      expected: 5,
    },
    {
      name: "estimateBase64DecodedBytes handles empty input",
      actual: estimateBase64DecodedBytes(""),
      expected: 0,
    },
  ] as const)("$name", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });
});

it.each<[string, boolean]>([
  ["", false],
  ["QQ==", true],
  ["QUI=", true],
  ["QUJD", true],
  ["ZE==", true], // Attachment validation historically accepts nonzero pad bits.
  ["QQ", false],
  ["QQ==\n", false],
  ["Q Q=", false],
  ["QQ$=", false],
  ["QQ-_", false],
  ["QQ=Q", false],
  ["Q===", false],
  ["====", false],
  ["QQ==QQ==", false],
])("validates attachment base64 %j without normalization", (value, accepted) => {
  expect(isValidBase64(value)).toBe(accepted);
});
