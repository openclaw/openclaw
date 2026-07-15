// Error-format helper tests cover the non-Error cause stringifier contract.
import { describe, expect, it } from "vitest";
import {
  configureAcpErrorRedactor,
  redactSensitiveText,
  stringifyNonErrorCause,
} from "./error-format.js";

describe("stringifyNonErrorCause", () => {
  it("returns a string for values JSON.stringify serializes to undefined", () => {
    // JSON.stringify(fn|symbol|undefined) is undefined; the `string`-typed helper must not leak it.
    expect(stringifyNonErrorCause(() => {})).toBe("[object Function]");
    expect(stringifyNonErrorCause(Symbol("x"))).toBe("[object Symbol]");
    expect(stringifyNonErrorCause(undefined)).toBe("[object Undefined]");
  });

  it("stringifies ordinary scalar and object causes", () => {
    expect(stringifyNonErrorCause({ a: 1 })).toBe('{"a":1}');
    expect(stringifyNonErrorCause("hi")).toBe("hi");
    expect(stringifyNonErrorCause(42)).toBe("42");
    expect(stringifyNonErrorCause(null)).toBe("null");
  });
});

describe("redactSensitiveText", () => {
  it("applies fallback secret redaction after a configured redactor", () => {
    configureAcpErrorRedactor((value) => value.replace("prefix", "host-redacted"));
    try {
      expect(redactSensitiveText("prefix ghp_123456789012345678901234")).toBe(
        "host-redacted [REDACTED]",
      );
    } finally {
      configureAcpErrorRedactor(undefined);
    }
  });

  it("redacts unquoted auth-style HTTP headers in fallback errors", () => {
    const keyHeader = ["api", "-", "key"].join("");
    const googleHeader = ["x", "-", "goog", "-", "api", "-", "key"].join("");
    const accessHeader = ["x", "-", "access", "-", "token"].join("");
    const input = [
      ["Authorization", ": token ", "samplevalue1234567890abcd"].join(""),
      ["Proxy-Authorization", ": Digest ", "sampleproxyvalue1234567890"].join(""),
      [keyHeader, ": ", "samplekeyvalue1234567890"].join(""),
      [googleHeader, "=", "samplegoogvalue1234567890"].join(""),
      [accessHeader, ": ", "sampleaccessvalue1234567890"].join(""),
    ].join("\n");

    expect(redactSensitiveText(input)).toBe(
      [
        ["Authorization", ": token ", "[REDACTED]"].join(""),
        ["Proxy-Authorization", ": Digest ", "[REDACTED]"].join(""),
        [keyHeader, ": ", "[REDACTED]"].join(""),
        [googleHeader, "=", "[REDACTED]"].join(""),
        [accessHeader, ": ", "[REDACTED]"].join(""),
      ].join("\n"),
    );
  });

  it("does not redact ordinary authorization prose in fallback errors", () => {
    const input = "the authorization model is open";

    expect(redactSensitiveText(input)).toBe(input);
  });
});
