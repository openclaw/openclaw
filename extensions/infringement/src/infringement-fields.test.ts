import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone } from "./infringement-fields.js";

describe("maskPhone", () => {
  it("keeps first 3 and last 4 digits of an 11-digit number", () => {
    expect(maskPhone("13812345678")).toBe("138****5678");
  });

  it("masks short values without leaking digits", () => {
    expect(maskPhone("1234")).toBe("****");
    expect(maskPhone("123456")).toBe("1****");
  });

  it("returns null for empty/nullish", () => {
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone(undefined)).toBeNull();
    expect(maskPhone("")).toBeNull();
    expect(maskPhone("   ")).toBeNull();
  });
});

describe("maskEmail", () => {
  it("keeps the first two local chars and the domain", () => {
    expect(maskEmail("albert@ibtai.com")).toBe("al***@ibtai.com");
  });

  it("handles very short local parts", () => {
    expect(maskEmail("a@x.com")).toBe("a***@x.com");
  });

  it("returns a safe token when there is no @", () => {
    expect(maskEmail("notanemail")).toBe("***");
  });

  it("returns null for empty/nullish", () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("")).toBeNull();
  });
});
