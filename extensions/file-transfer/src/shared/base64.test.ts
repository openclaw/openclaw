import { describe, expect, it } from "vitest";
import { inspectStrictBase64 } from "./base64.js";

describe("inspectStrictBase64", () => {
  it.each([
    ["", 0],
    ["AA", 1],
    ["AA==", 1],
    ["+/8", 2],
    ["+/8=", 2],
    ["-_8=", 2],
    ["AAAA", 3],
  ] as const)("reports the decoded size of %j", (value, bytes) => {
    expect(inspectStrictBase64(value)).toBe(bytes);
  });

  it.each(["A", "A===", "AA=A", "=", "==", "AA=", "AAA==", "AA\n", "AA\r\n", "AA ", "Aé"])(
    "rejects malformed input without decoding: %j",
    (value) => {
      expect(inspectStrictBase64(value)).toBeUndefined();
    },
  );
});
