import { describe, expect, it, vi } from "vitest";
import { runQaSuiteWithInfraRetry } from "./suite-infra-retry.js";
import { throwQaSuiteCleanupErrors } from "./suite.js";

describe("qa suite infrastructure retry", () => {
  it("retries a cleanup-only ECONNRESET through its preserved cause", async () => {
    const cleanupError = Object.assign(new Error("cleanup socket reset"), {
      code: "ECONNRESET",
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    let attempts = 0;

    try {
      const result = await runQaSuiteWithInfraRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
          throwQaSuiteCleanupErrors({
            cleanupFailures: [{ phase: "lab stop", error: cleanupError }],
            runFailed: false,
            runError: undefined,
          });
        }
        return "retried";
      }, 1);

      expect(result).toBe("retried");
      expect(attempts).toBe(2);
      expect(stderrWrite.mock.calls.flat().join("")).toContain("[qa-suite] infra retry 1/1:");
    } finally {
      stderrWrite.mockRestore();
    }
  });
});
