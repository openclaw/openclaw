import { expect, it, vi } from "vitest";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

function createExecutorHarness(prepareArguments: NonNullable<AnyAgentTool["prepareArguments"]>) {
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const tool: AnyAgentTool = {
    ...createStubTool("memory_search"),
    prepareArguments,
    execute,
  };
  const runToolLifecycle = vi.fn(
    async ({
      execute: run,
    }: {
      args: unknown;
      execute: (onImplementationStart: () => void) => Promise<unknown>;
    }) => await run(() => {}),
  );
  const executor = createSubscribedToolSearchExecutor({
    attempt: { runId: "run", sessionKey: "key" },
    runSignal: new AbortController().signal,
    sessionManager: { getAppendParentId: () => undefined } as never,
    subscription: { runToolLifecycle } as never,
    isCurrent: () => true,
    isReplaySafeTool: () => true,
    nestedToolActivityState: { scopeId: "scope", successfulToolNames: new Set() },
  });
  return {
    execute,
    runToolLifecycle,
    run: (input: unknown) =>
      executor({
        tool,
        toolName: "memory_search",
        source: "openclaw",
        sourceName: "memory-core",
        toolCallId: "call",
        input,
        acceptResultBeforeProjection: async (result) => result,
      }),
  };
}

it("prepares tool arguments before lifecycle and execution", async () => {
  const input = { query: "orchid codename", min_score: 0.01, max_results: 3 };
  const preparedInput = { query: "orchid codename", maxResults: 3 };
  const prepareArguments = vi.fn(() => preparedInput);
  const { run, execute, runToolLifecycle } = createExecutorHarness(prepareArguments);
  await run(input);
  expect(prepareArguments).toHaveBeenCalledWith(input);
  expect(runToolLifecycle.mock.calls[0]?.[0].args).toBe(preparedInput);
  expect(execute).toHaveBeenCalledWith("call", preparedInput, expect.any(AbortSignal), undefined);
});

it("runs argument preparation failures through the nested lifecycle", async () => {
  const input = { query: "orchid codename", min_score: 0.01 };
  const error = new Error("invalid arguments");
  const prepareArguments = vi.fn(() => {
    throw error;
  });
  const { run, execute, runToolLifecycle } = createExecutorHarness(prepareArguments);
  await expect(run(input)).rejects.toBe(error);
  expect(prepareArguments).toHaveBeenCalledWith(input);
  expect(runToolLifecycle.mock.calls[0]?.[0].args).toBe(input);
  expect(execute).not.toHaveBeenCalled();
});
