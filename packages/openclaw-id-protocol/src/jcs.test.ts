import { describe, expect, it } from "vitest";
import { canonicalize } from "./jcs.js";

describe("canonicalize (RFC 8785)", () => {
  it("sorts keys by UTF-16 code units and serializes numbers the ECMAScript way", () => {
    // RFC 8785 section 3.2.3 sorting example and section 3.2.2.3 number forms.
    expect(
      canonicalize({
        "\u20ac": 1,
        "\r": 2,
        "\ufb33": 3,
        "1": 4,
        "\ud83d\ude00": 5,
        "\u0080": 6,
        "\u00f6": 7,
      }),
    ).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}');
    expect(canonicalize([-0, 1e21, 1e-7, 0.1, 333333333.3333333, 4.5])).toBe(
      "[0,1e+21,1e-7,0.1,333333333.3333333,4.5]",
    );
  });

  it("omits undefined members and rejects values JSON cannot carry", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalize("\ud800")).toThrow(/lone surrogate/);
  });
});
