import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../../tools/common.js";
import { createSubscribedToolSearchExecutor } from "./attempt-tool-search-executor.js";

describe("createSubscribedToolSearchExecutor", () => {
  it("prepares tool arguments before lifecycle and execution", async () => {
    const preparedInput = { query: "orchid codename", maxResults: 3 };
    const prepareArguments = vi.fn(() => preparedInput);
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = {
      name: "memory_search",
      prepareArguments,
      execute,
    } as unknown as AnyAgentTool;
    let lifecycleArgs: unknown;
    const runToolLifecycle = vi.fn(
      async ({
        args,
        execute: run,
      }: {
        args: unknown;
        execute: (onImplementationStart: () => void) => Promise<unknown>;
      }) => {
        lifecycleArgs = args;
        return await run(() => {});
      },
    );
    const runSignal = new AbortController().signal;
    const executor = createSubscribedToolSearchExecutor({
      attempt: { config: {}, runId: "run", sessionId: "session", sessionKey: "key" },
      runSignal,
      sessionManager: { getAppendParentId: () => undefined } as never,
      subscription: { runToolLifecycle } as never,
      isCurrent: () => true,
      isReplaySafeTool: () => true,
      nestedToolActivities: [],
    });

    await executor({
      tool,
      toolName: "memory_search",
      source: "openclaw",
      sourceName: "memory-core",
      toolCallId: "call",
      input: { query: "orchid codename", min_score: 0.01, max_results: 3 },
      acceptResultBeforeProjection: async (result) => result,
    });

    expect(prepareArguments).toHaveBeenCalledWith({
      query: "orchid codename",
      min_score: 0.01,
      max_results: 3,
    });
    expect(lifecycleArgs).toBe(preparedInput);
    expect(execute).toHaveBeenCalledWith("call", preparedInput, expect.any(AbortSignal), undefined);
  });

  it("runs argument preparation failures through the nested lifecycle", async () => {
    const input = { query: "orchid codename", min_score: 0.01 };
    const error = new Error("invalid arguments");
    const prepareArguments = vi.fn(() => {
      throw error;
    });
    const execute = vi.fn();
    const tool = {
      name: "memory_search",
      prepareArguments,
      execute,
    } as unknown as AnyAgentTool;
    let lifecycleArgs: unknown;
    const runToolLifecycle = vi.fn(
      async ({
        args,
        execute: run,
      }: {
        args: unknown;
        execute: (onImplementationStart: () => void) => Promise<unknown>;
      }) => {
        lifecycleArgs = args;
        return await run(() => {});
      },
    );
    const executor = createSubscribedToolSearchExecutor({
      attempt: { config: {}, runId: "run", sessionId: "session", sessionKey: "key" },
      runSignal: new AbortController().signal,
      sessionManager: { getAppendParentId: () => undefined } as never,
      subscription: { runToolLifecycle } as never,
      isCurrent: () => true,
      isReplaySafeTool: () => true,
      nestedToolActivities: [],
    });

    await expect(
      executor({
        tool,
        toolName: "memory_search",
        source: "openclaw",
        sourceName: "memory-core",
        toolCallId: "call",
        input,
        acceptResultBeforeProjection: async (result) => result,
      }),
    ).rejects.toBe(error);

    expect(prepareArguments).toHaveBeenCalledWith(input);
    expect(lifecycleArgs).toBe(input);
    expect(execute).not.toHaveBeenCalled();
  });
});
