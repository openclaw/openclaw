// Media Core tests cover base64 behavior.
import { describe, expect, it } from "vitest";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "./base64.js";

/**
 * Generates a large valid base64 string (~2.7M chars) simulating a ~2MB PNG
 * clipboard screenshot. The raw bytes are a valid PNG header followed by
 * filler so sniffers still recognise it as image/png.
 */
function largePngBase64(sizeBytes = 2_000_000): string {
  const buffer = Buffer.alloc(sizeBytes);
  // PNG magic bytes
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR chunk marker (minimal)
  buffer.write("IHDR", 12, "ascii");
  return buffer.toString("base64");
}

describe("base64 helpers", () => {
  function expectBase64HelperCase<T>(actual: T, expected: T) {
    expect(actual).toBe(expected);
  }

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
    expectBase64HelperCase(actual, expected);
  });

  it("canonicalizeBase64 does not overflow the call stack on ~2MB PNG payloads", () => {
    // Regression: character-by-character string concatenation (`cleaned += ch`)
    // produced a deeply nested V8 cons-string that overflowed the stack when
    // flattened. A ~2MB screenshot encodes to ~2.7M base64 chars.
    const large = largePngBase64(2_000_000);
    expect(large.length).toBeGreaterThan(2_600_000);

    const result = canonicalizeBase64(large);
    expect(result).toBeDefined();
    // The result must be a flat string — .slice() and Buffer.from() must not
    // throw RangeError.
    expect(() => result!.slice(0, 256)).not.toThrow();
    expect(() => Buffer.from(result!.slice(0, 256), "base64")).not.toThrow();
    // Correctness: canonical output should equal the input (no whitespace to strip).
    expect(result).toBe(large);
  });

  it("canonicalizeBase64 handles large payloads with whitespace without stack overflow", () => {
    const large = largePngBase64(2_000_000);
    // Insert whitespace every 4096 chars to exercise the whitespace-stripping path.
    const withWhitespace = large.replace(/(.{4096})/g, "$1\n");
    const result = canonicalizeBase64(withWhitespace);
    expect(result).toBeDefined();
    expect(() => result!.slice(0, 256)).not.toThrow();
    expect(result).toBe(large);
  });
});
