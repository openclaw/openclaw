import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("./crabbox-worker-command.js");
  vi.resetModules();
});

it.each([
  ["supported", commandResult({ stdout: "crabbox 999.0.0" })],
  ["indeterminate", commandResult({ code: 1 })],
] as const)("keeps the error runtime cold for a %s result", async (status, result) => {
  const evaluate = vi.fn(() => {
    throw new Error("error runtime must stay cold");
  });
  // mock-isolation: Observe module evaluation without loading the error runtime.
  vi.doMock("./crabbox-worker-command.js", evaluate);
  const { probeCrabboxVersion } = await import("./crabbox-managed-binary.js");
  await expect(probeCrabboxVersion("crabbox", async () => result)).resolves.toMatchObject({
    status,
  });
  expect(evaluate).not.toHaveBeenCalled();
});

it("rejects an aborted runner without loading the error runtime", async () => {
  const evaluate = vi.fn(() => {
    throw new Error("error runtime must stay cold");
  });
  // mock-isolation: Cancellation must precede error-runtime module evaluation.
  vi.doMock("./crabbox-worker-command.js", evaluate);
  const { probeCrabboxVersion } = await import("./crabbox-managed-binary.js");
  const controller = new AbortController();
  const reason = new Error("probe cancelled");
  await expect(
    probeCrabboxVersion(
      "crabbox",
      async () => {
        controller.abort(reason);
        throw new Error("runner failed");
      },
      controller.signal,
    ),
  ).rejects.toBe(reason);
  expect(evaluate).not.toHaveBeenCalled();
});

it.each([false, true])(
  "loads a thrown error's formatter, retaining cancellation (%s)",
  async (abort) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const formatter = vi.fn(() => new Error("formatted failure"));
    // mock-isolation: Hold module evaluation to test cancellation across the import.
    vi.doMock("./crabbox-worker-command.js", async () => {
      started.resolve();
      await release.promise;
      return { crabboxExecutionError: formatter };
    });
    const { probeCrabboxVersion } = await import("./crabbox-managed-binary.js");
    const controller = new AbortController();
    const reason = new Error("cancelled during import");
    const failure = new Error("runner failed");
    const pending = probeCrabboxVersion(
      "crabbox",
      async () => {
        throw failure;
      },
      controller.signal,
    );
    const outcome = abort
      ? expect(pending).rejects.toBe(reason)
      : expect(pending).resolves.toEqual({ status: "indeterminate", reason: "formatted failure" });
    try {
      await started.promise;
      if (abort) {
        controller.abort(reason);
      }
    } finally {
      release.resolve();
      await outcome;
    }
    if (abort) {
      expect(formatter).not.toHaveBeenCalled();
    } else {
      expect(formatter).toHaveBeenCalledExactlyOnceWith("version command", failure);
    }
  },
);
