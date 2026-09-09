// Unit coverage for the context-service seam abort-timeout resolver.
//
// The seam abort budget was hard-coded at 800ms, which is below a cold
// query-embedding round-trip (~700-760ms), so a legitimate cold context-service
// call was aborted and silently fell through to the dead native path. The
// budget is now configurable via FRED_CONTEXT_SERVICE_TIMEOUT_MS with a 2500ms
// default and [100, 30000]ms clamp. These tests pin that contract.
import { describe, expect, it } from "vitest";
import { resolveContextServiceTimeoutMs } from "./manager.js";

describe("resolveContextServiceTimeoutMs", () => {
  it("defaults to 2500ms when unset or blank", () => {
    expect(resolveContextServiceTimeoutMs(undefined)).toBe(2500);
    expect(resolveContextServiceTimeoutMs("")).toBe(2500);
    expect(resolveContextServiceTimeoutMs("   ")).toBe(2500);
  });

  it("parses a valid positive integer", () => {
    expect(resolveContextServiceTimeoutMs("1500")).toBe(1500);
    expect(resolveContextServiceTimeoutMs("2500")).toBe(2500);
  });

  it("clamps to [100, 30000]", () => {
    expect(resolveContextServiceTimeoutMs("5")).toBe(100);
    expect(resolveContextServiceTimeoutMs("99999")).toBe(30000);
  });

  it("falls back to the default on invalid input", () => {
    expect(resolveContextServiceTimeoutMs("abc")).toBe(2500);
    expect(resolveContextServiceTimeoutMs("-100")).toBe(2500);
    expect(resolveContextServiceTimeoutMs("0")).toBe(2500);
  });
});
