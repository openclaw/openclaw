import { describe, expect, it } from "vitest";
import { readAccessToken } from "./token-response.js";

describe("readAccessToken", () => {
  it("returns raw string token values", () => {
    expect(readAccessToken("abc")).toBe("abc");
  });

  it("returns accessToken from object value", () => {
    expect(readAccessToken({ accessToken: "access-token" })).toBe("access-token");
  });

  it("returns token fallback from object value", () => {
    expect(readAccessToken({ token: "fallback-token" })).toBe("fallback-token");
  });

  it("returns null for unsupported values", () => {
    expect(readAccessToken({ accessToken: 123 })).toBeNull();
    expect(readAccessToken({ token: false })).toBeNull();
    expect(readAccessToken(null)).toBeNull();
    expect(readAccessToken(undefined)).toBeNull();
  });
});
