import { describe, expect, it } from "vitest";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import {
  classifyRecoverableNativeHarnessBindingFailure,
  isNativeHarnessBindingRecoverySkip,
  isRecoverableNativeHarnessBindingFailure,
} from "./compaction-recovery.js";

function failure(overrides: Partial<EmbeddedAgentCompactResult>): EmbeddedAgentCompactResult {
  return { ok: false, compacted: false, ...overrides };
}

describe("classifyRecoverableNativeHarnessBindingFailure", () => {
  it.each([
    [{ failure: { reason: "missing_thread_binding" } }, "missing_thread_binding"],
    [{ failure: { reason: "stale_thread_binding" } }, "stale_thread_binding"],
    [{ reason: "thread not found: <id>" }, "thread_not_found"],
    [{ reason: "no thread binding for session" }, "missing_thread_binding"],
    [{ reason: "STALE_THREAD_BINDING" }, "stale_thread_binding"],
  ] as const)("maps %o to %s", (overrides, expected) => {
    const result = failure(overrides);
    expect(classifyRecoverableNativeHarnessBindingFailure(result)).toBe(expected);
    expect(isRecoverableNativeHarnessBindingFailure(result)).toBe(true);
  });

  it("prefers the structured failure reason over the display reason", () => {
    const result = failure({
      reason: "thread not found",
      failure: { reason: "stale_thread_binding" },
    });
    expect(classifyRecoverableNativeHarnessBindingFailure(result)).toBe("stale_thread_binding");
  });

  it.each([
    failure({ reason: "native compaction unavailable", failure: { reason: "native_unavailable" } }),
    failure({ reason: "auth profile mismatch" }),
    failure({}),
    { ok: true, compacted: false, reason: "thread not found" } as EmbeddedAgentCompactResult,
    undefined,
  ])("does not classify non-recoverable result %#", (result) => {
    expect(classifyRecoverableNativeHarnessBindingFailure(result)).toBeUndefined();
    expect(isRecoverableNativeHarnessBindingFailure(result)).toBe(false);
  });
});

describe("isNativeHarnessBindingRecoverySkip", () => {
  it("is true only when the typed disposition is present", () => {
    expect(
      isNativeHarnessBindingRecoverySkip(
        failure({ nativeHarnessBindingRecoveryReason: "stale_thread_binding" }),
      ),
    ).toBe(true);
    expect(
      isNativeHarnessBindingRecoverySkip(failure({ failure: { reason: "stale_thread_binding" } })),
    ).toBe(false);
    expect(isNativeHarnessBindingRecoverySkip(undefined)).toBe(false);
  });
});
