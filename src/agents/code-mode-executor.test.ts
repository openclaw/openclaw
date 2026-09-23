import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeModeExecutorContinuation } from "./code-mode-executor-types.js";
import { runCodeModeExecutor } from "./code-mode-executor.js";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), execute: vi.fn() }));
vi.mock("../plugins/code-mode-executor.js", () => ({
  resolvePluginCodeModeExecutor: mocks.resolve,
}));

const config = {
  timeoutMs: 1_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 65_536,
  maxSnapshotBytes: 10 * 1024 * 1024,
  maxPendingToolCalls: 16,
};
const input = {
  kind: "exec" as const,
  source: "return 1;",
  executionTimeoutMs: 300,
  config,
  catalog: [],
  namespaces: [],
};
const completed = {
  status: "completed" as const,
  output: EMPTY_CODE_MODE_OUTPUT,
  value: { kind: "complete" as const, json: "1" },
};
let now = 0;

beforeEach(() => {
  now = 0;
  mocks.execute.mockReset().mockResolvedValue(completed);
  mocks.resolve.mockReset().mockReturnValue({ id: "quickjs", execute: mocks.execute });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("Code Mode executor admission", () => {
  it("charges executor loading to the wall budget while preserving the separate CPU grant", async () => {
    mocks.resolve.mockImplementation(() => {
      now = 250;
      return { id: "quickjs", execute: mocks.execute };
    });
    expect(
      await runCodeModeExecutor(input, {
        executor: "quickjs",
        timeoutMs: 3_000,
        runtimeConfig: { plugins: { enabled: false } },
      }),
    ).toEqual(completed);
    expect(mocks.execute).toHaveBeenCalledWith(
      { ...input, config: { ...config, timeoutMs: 750 } },
      { timeoutMs: 2_750, signal: undefined, inlineHost: undefined },
    );
  });

  it("does not admit guest execution when loading consumes the entire grant", async () => {
    mocks.resolve.mockImplementation(() => {
      now = 1_000;
      return { id: "quickjs", execute: mocks.execute };
    });
    await expect(
      runCodeModeExecutor(input, { executor: "quickjs", timeoutMs: 3_000 }),
    ).resolves.toMatchObject({ status: "failed", code: "timeout" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after loading the selected executor", async () => {
    const abort = new AbortController();
    mocks.resolve.mockImplementation(() => {
      abort.abort();
      return { id: "quickjs", execute: mocks.execute };
    });
    await expect(
      runCodeModeExecutor(input, {
        executor: "quickjs",
        timeoutMs: 3_000,
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({ status: "failed", code: "aborted" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("resumes the admitted continuation when the current executor selection differs", async () => {
    const continuation: CodeModeExecutorContinuation = {
      executor: "quickjs",
      retainedBytes: 1,
      resume: vi.fn().mockResolvedValue(completed),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      runCodeModeExecutor(
        { kind: "resume", continuation, config, settledRequests: [] },
        { executor: "node", timeoutMs: 3_000 },
      ),
    ).resolves.toEqual(completed);
    expect(continuation.resume).toHaveBeenCalledOnce();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
