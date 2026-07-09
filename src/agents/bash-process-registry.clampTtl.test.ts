/**
 * Focused regression test: `clampTtl` must NOT treat numeric `0` as "unset".
 *
 * Before the fix, `!value` caught `0` as falsy and returned DEFAULT_JOB_TTL_MS
 * (30 minutes). The fix uses `value === undefined` to match `clampWithDefault`
 * and `setJobTtlMs` guard style, so `0` is clamped to MIN_JOB_TTL_MS (1 minute).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { setJobTtlMs, resetProcessRegistryForTests } from "./bash-process-registry.js";

describe("clampTtl zero-value guard", () => {
  afterEach(() => {
    resetProcessRegistryForTests();
  });

  test("setJobTtlMs(0) clamps to MIN (60s) rather than DEFAULT (30min)", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      setJobTtlMs(0);
      // MIN_JOB_TTL_MS = 60_000  → sweeper interval = Math.max(30_000, 60_000/6) = 30_000
      // DEFAULT_JOB_TTL_MS = 1_800_000 → would be Math.max(30_000, 1_800_000/6) = 300_000
      expect(spy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    } finally {
      spy.mockRestore();
    }
  });

  test("setJobTtlMs() (no arg) is a no-op", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    try {
      setJobTtlMs();
      // undefined → guard returns early, no sweeper (re)start
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
