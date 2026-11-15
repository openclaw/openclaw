// Tlon tests cover base url plugin behavior.
import { describe, expect, it } from "vitest";
import { validateUrbitBaseUrl } from "./base-url.js";

describe("validateUrbitBaseUrl", () => {
  function expectValidBaseUrl(raw: string) {
    const result = validateUrbitBaseUrl(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result;
  }

  it("rejects non-http schemes", () => {
    const result = validateUrbitBaseUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("http:// or https://");
  });

  it("rejects embedded credentials", () => {
    const result = validateUrbitBaseUrl("https://user:pass@example.com");
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("credentials");
  });

  it.each([["[2001:db8::2]:8443/path", "https://[2001:db8::2]:8443"]])(
    "preserves a usable IPv6 ship origin for %s",
    (raw, expectedOrigin) => {
      const result = expectValidBaseUrl(raw);
      expect(result.baseUrl).toBe(expectedOrigin);
      expect(new URL("/~/login", result.baseUrl).origin).toBe(expectedOrigin);
    },
  );
});
