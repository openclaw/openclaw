import { describe, expect, it } from "vitest";
import { formatByteSize } from "./format.js";

describe("formatByteSize", () => {
  it("keeps scale and labels explicit", () => {
    expect(
      formatByteSize(1024, {
        style: "iec",
        maxUnit: "mega",
        separator: " ",
        fractionDigits: 1,
      }),
    ).toBe("1.0 KiB");
    expect(
      formatByteSize(1000, {
        style: "si",
        maxUnit: "mega",
        separator: " ",
        fractionDigits: 1,
      }),
    ).toBe("1.0 kB");
    expect(
      formatByteSize(1024, {
        style: "legacy-binary",
        maxUnit: "mega",
        separator: "",
        fractionDigits: 1,
      }),
    ).toBe("1.0KB");
  });

  it("supports caller-owned precision and rounding", () => {
    expect(
      formatByteSize(Math.floor(99.6 * 1024 * 1024), {
        style: "legacy-binary",
        maxUnit: "giga",
        separator: " ",
        fractionDigits: (_value, unit) => (unit === "giga" ? 1 : unit === "byte" ? null : 0),
        rounding: (_value, unit) => (unit === "kilo" || unit === "mega" ? "floor" : "round"),
      }),
    ).toBe("99 MB");
  });

  it("caps promotion at the requested maximum unit", () => {
    expect(
      formatByteSize(5 * 1024 * 1024, {
        style: "legacy-binary",
        maxUnit: "kilo",
        separator: " ",
        fractionDigits: 1,
      }),
    ).toBe("5120.0 KB");
  });
});
