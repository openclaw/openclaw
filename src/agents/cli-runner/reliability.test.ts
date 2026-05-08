import { describe, expect, it } from "vitest";
import { CLI_RESUME_WATCHDOG_DEFAULTS } from "../cli-watchdog-defaults.js";
import { resolveCliNoOutputTimeoutMs } from "./reliability.js";

const baseBackend = { command: "/usr/local/bin/claude" } as Parameters<
  typeof resolveCliNoOutputTimeoutMs
>[0]["backend"];

describe("resolveCliNoOutputTimeoutMs — payloadNoOutputTimeoutMs", () => {
  it("uses profile maxMs when payload is unset", () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: baseBackend,
      timeoutMs: 300_000,
      useResume: true,
    });
    expect(result).toBeLessThanOrEqual(CLI_RESUME_WATCHDOG_DEFAULTS.maxMs);
  });

  it("honours payload override on resume when it exceeds the profile maxMs", () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: baseBackend,
      timeoutMs: 900_000,
      useResume: true,
      payloadNoOutputTimeoutMs: 600_000,
    });
    expect(result).toBe(600_000);
  });

  it("ignores payload override when it does not exceed profile maxMs", () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: baseBackend,
      timeoutMs: 300_000,
      useResume: true,
      payloadNoOutputTimeoutMs: 60_000,
    });
    // 60_000 <= CLI_RESUME_WATCHDOG_DEFAULTS.maxMs (180_000) → normal path applies
    expect(result).toBeLessThanOrEqual(CLI_RESUME_WATCHDOG_DEFAULTS.maxMs);
  });

  it("clamps payload override to 1_800_000 ms hard upper bound", () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: baseBackend,
      timeoutMs: 7_200_000,
      useResume: true,
      payloadNoOutputTimeoutMs: 9_999_999,
    });
    expect(result).toBe(1_800_000);
  });

  it("does not apply payload override on fresh (non-resume) sessions", () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: baseBackend,
      timeoutMs: 900_000,
      useResume: false,
      payloadNoOutputTimeoutMs: 600_000,
    });
    // Fresh sessions use CLI_FRESH_WATCHDOG_DEFAULTS — payload override ignored
    expect(result).toBeLessThanOrEqual(600_000);
    // Should follow fresh watchdog ratio (0.8), not the payload value
    const freshRatioBound = Math.floor(900_000 * 0.8);
    expect(result).toBeLessThanOrEqual(freshRatioBound);
  });
});
