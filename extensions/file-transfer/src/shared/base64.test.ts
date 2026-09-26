import { describe, expect, it } from "vitest";
import { inspectStrictBase64 } from "./base64.js";

describe("inspectStrictBase64", () => {
  it("accepts standard alphabet punctuation", () => {
    expect(inspectStrictBase64("+/8=")).toBe(2);
  });

  it.each(["A", "A===", "AA=A"])("rejects malformed input without decoding: %j", (value) => {
    expect(inspectStrictBase64(value)).toBeUndefined();
  });
});
