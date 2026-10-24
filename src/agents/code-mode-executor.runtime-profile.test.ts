import { describe, expect, it, vi } from "vitest";
import type { CodeModeExecutorContinuation } from "./code-mode-executor-types.js";
import { runCodeModeExecutor } from "./code-mode-executor.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";

vi.mock("../../cli-invocation.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cli-invocation.mjs")>()),
  getStandaloneRuntimeBuild: () => ({ mode: "aot" }),
}));

const config = {
  timeoutMs: 1_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 65_536,
  maxSnapshotBytes: 10 * 1024 * 1024,
  maxPendingToolCalls: 16,
};
const completed = {
  status: "completed" as const,
  output: EMPTY_CODE_MODE_OUTPUT,
  value: { kind: "complete" as const, json: "42" },
};

describe("Code Mode in the embedded AOT profile", () => {
  it("reports runtime_unavailable before starting a Node cell", async () => {
    const result = await runCodeModeExecutor(
      {
        kind: "exec",
        source: "return 42;",
        executionTimeoutMs: 300,
        config,
        catalog: [],
        namespaces: [],
      },
      { executor: "node", timeoutMs: 1_000 },
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      failurePhase: "host",
      bridgeDispatchStarted: false,
      error: expect.stringContaining("Node/Bun installation or a JIT/bytecode standalone"),
    });
  });

  it.each(["node", "quickjs"] as const)(
    "checks the retained %s executor instead of the new selection",
    async (executor) => {
      const continuation: CodeModeExecutorContinuation = {
        executor,
        retainedBytes: 1,
        resume: vi.fn().mockResolvedValue(completed),
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const result = await runCodeModeExecutor(
        { kind: "resume", continuation, config, settledRequests: [] },
        { executor: executor === "node" ? "quickjs" : "node", timeoutMs: 1_000 },
      );
      if (executor === "node") {
        expect(result).toMatchObject({ status: "failed", code: "runtime_unavailable" });
        expect(continuation.resume).not.toHaveBeenCalled();
        expect(continuation.dispose).toHaveBeenCalledOnce();
      } else {
        expect(result).toEqual(completed);
        expect(continuation.resume).toHaveBeenCalledOnce();
      }
    },
  );
});
