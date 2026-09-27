import { describe, expect, it, vi } from "vitest";
import { QaSuiteCleanupError } from "./errors.js";
import { runQaSuiteWithInfraRetry } from "./suite-infra-retry.js";
import { throwQaSuiteCleanupErrors } from "./suite.js";

describe("qa suite infrastructure retry", () => {
  it.each([false, true])(
    "preserves the attempt when its failure hook throws (fatal=%s)",
    async (fatal) => {
      const original = fatal
        ? new QaSuiteCleanupError([new Error("child still running")], "cleanup unconfirmed")
        : Object.assign(new Error("attempt connection reset"), { code: "ECONNRESET" });
      const recording = Object.assign(new Error("failure recording reset"), {
        code: "ECONNRESET",
      });
      const run = vi.fn(async () => {
        throw original;
      });
      const onAttemptFailure = vi.fn(() => {
        throw recording;
      });
      const outcome = await runQaSuiteWithInfraRetry(run, 1, undefined, {
        onAttemptFailure,
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(fatal ? QaSuiteCleanupError : AggregateError);
      expect(outcome).toMatchObject({ cause: original, errors: [original, recording] });
      expect(run).toHaveBeenCalledExactlyOnceWith(0);
      expect(onAttemptFailure).toHaveBeenCalledExactlyOnceWith(original, fatal);
    },
  );

  it("lets the first cancelled attempt establish its evidence owner", async () => {
    const reason = new Error("cancelled before invocation");
    const signal = AbortSignal.abort(reason);
    const run = vi.fn(async () => {
      signal.throwIfAborted();
    });
    await expect(runQaSuiteWithInfraRetry(run, 1, signal)).rejects.toBe(reason);
    expect(run).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("does not admit another attempt when cancellation follows the retry decision", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before retry admission");
    const run = vi.fn(async () => {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(
        runQaSuiteWithInfraRetry(run, 1, controller.signal, {
          onAttemptFailure: () => controller.abort(reason),
        }),
      ).rejects.toBe(reason);
      expect(run).toHaveBeenCalledExactlyOnceWith(0);
    } finally {
      stderrWrite.mockRestore();
    }
  });

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
