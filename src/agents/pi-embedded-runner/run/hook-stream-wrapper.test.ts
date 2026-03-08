import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Model, Api, Context } from "@mariozechner/pi-ai";
/**
 * Integration tests for wrapStreamFnWithHooks().
 *
 * Verifies that the hook-aware StreamFn wrapper correctly fires
 * before_llm_call hooks, applies modifications,
 * blocks calls, and is resilient to hook errors.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";
import { wrapStreamFnWithHooks } from "./hook-stream-wrapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMsg(role: string, content: string): AgentMessage {
  return { role, content } as AgentMessage;
}

function makeMockHookRunner(
  overrides: Partial<Record<keyof HookRunner, unknown>> = {},
): HookRunner {
  return {
    hasHooks: vi.fn().mockReturnValue(true),
    runBeforeAgentStart: vi.fn(),
    runAgentEnd: vi.fn(),
    runBeforeCompaction: vi.fn(),
    runAfterCompaction: vi.fn(),
    runMessageReceived: vi.fn(),
    runMessageSending: vi.fn(),
    runMessageSent: vi.fn(),
    runBeforeToolCall: vi.fn(),
    runAfterToolCall: vi.fn(),
    runToolResultPersist: vi.fn(),
    runSessionStart: vi.fn(),
    runSessionEnd: vi.fn(),
    runGatewayStart: vi.fn(),
    runGatewayStop: vi.fn(),
    runBeforeLlmCall: vi.fn().mockResolvedValue(undefined),
    runAfterLlmCall: vi.fn(),
    getHookCount: vi.fn().mockReturnValue(0),
    ...overrides,
  } as unknown as HookRunner;
}

const agentCtx: PluginHookAgentContext = {
  agentId: "test-agent",
  sessionKey: "test-session",
};

const mockStream = Symbol("mock-stream");

function makeBaseContext() {
  return {
    systemPrompt: "You are helpful.",
    messages: [fakeMsg("user", "hello")] as unknown[],
    tools: [
      { name: "read", description: "Read files", parameters: {} },
      { name: "exec", description: "Execute commands", parameters: {} },
    ],
  };
}

describe("wrapStreamFnWithHooks", () => {
  let streamFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    streamFn = vi.fn().mockReturnValue(mockStream);
  });

  it("before_llm_call fires on every call", async () => {
    const hookRunner = makeMockHookRunner();
    const iterationRef = { current: 0 };
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef,
      modelId: "gpt-4",
    });

    const context = makeBaseContext() as unknown as Context;
    await wrapped("gpt-4" as unknown as Model<Api>, context, {});
    iterationRef.current = 1;
    await wrapped("gpt-4" as unknown as Model<Api>, context, {});

    expect(hookRunner.runBeforeLlmCall).toHaveBeenCalledTimes(2);

    // First call
    const [event1] = (hookRunner.runBeforeLlmCall as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(event1).toMatchObject({
      model: "gpt-4",
      iteration: 0,
      systemPrompt: "You are helpful.",
    });

    // Second call
    const [event2] = (hookRunner.runBeforeLlmCall as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(event2).toMatchObject({
      model: "gpt-4",
      iteration: 1,
    });
  });

  it("before_llm_call can modify context", async () => {
    const modifiedMessages = [fakeMsg("user", "sanitized")];
    const hookRunner = makeMockHookRunner({
      runBeforeLlmCall: vi.fn().mockResolvedValue({
        systemPrompt: "modified prompt",
        messages: modifiedMessages,
      }),
    });
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 0 },
      modelId: "gpt-4",
    });

    await wrapped("gpt-4" as unknown as Model<Api>, makeBaseContext() as unknown as Context, {});

    expect(streamFn).toHaveBeenCalledOnce();
    const passedContext = streamFn.mock.calls[0][1];
    expect(passedContext.systemPrompt).toBe("modified prompt");
    expect(passedContext.messages).toBe(modifiedMessages);
  });

  it("before_llm_call can filter tools", async () => {
    const hookRunner = makeMockHookRunner({
      runBeforeLlmCall: vi.fn().mockResolvedValue({
        tools: [{ name: "read" }],
      }),
    });
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 0 },
      modelId: "gpt-4",
    });

    await wrapped("gpt-4" as unknown as Model<Api>, makeBaseContext() as unknown as Context, {});

    expect(streamFn).toHaveBeenCalledOnce();
    const passedContext = streamFn.mock.calls[0][1];
    // Only the "read" tool should remain (filtered by allowed names)
    expect(passedContext.tools).toHaveLength(1);
    expect(passedContext.tools[0].name).toBe("read");
  });

  it("before_llm_call can block", async () => {
    const hookRunner = makeMockHookRunner({
      runBeforeLlmCall: vi.fn().mockResolvedValue({
        block: true,
        blockReason: "tainted context",
      }),
    });
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 0 },
      modelId: "gpt-4",
    });

    await expect(
      wrapped("gpt-4" as unknown as Model<Api>, makeBaseContext() as unknown as Context, {}),
    ).rejects.toThrow("LLM call blocked by plugin: tainted context");
    expect(streamFn).not.toHaveBeenCalled();
  });

  it("before_llm_call error does not break stream", async () => {
    const hookRunner = makeMockHookRunner({
      runBeforeLlmCall: vi.fn().mockRejectedValue(new Error("hook kaboom")),
    });
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 0 },
      modelId: "gpt-4",
    });

    const result = await wrapped(
      "gpt-4" as unknown as Model<Api>,
      makeBaseContext() as unknown as Context,
      {},
    );

    // Should still call the underlying streamFn and return its result
    expect(streamFn).toHaveBeenCalledOnce();
    expect(result).toBe(mockStream);
  });

  it("passes through to underlying streamFn when no hooks", async () => {
    const hookRunner = makeMockHookRunner({
      hasHooks: vi.fn().mockReturnValue(false),
    });
    const wrapped = wrapStreamFnWithHooks(streamFn as unknown as StreamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 0 },
      modelId: "gpt-4",
    });

    const context = makeBaseContext() as unknown as Context;
    const result = await wrapped("gpt-4" as unknown as Model<Api>, context, {});

    // before_llm_call should not be called when no hooks registered
    expect(hookRunner.runBeforeLlmCall).not.toHaveBeenCalled();
    // Underlying streamFn receives original context unchanged
    expect(streamFn).toHaveBeenCalledWith("gpt-4", context, {});
    expect(result).toBe(mockStream);
  });

  it("treats messages:[] as explicit override (clears history)", async () => {
    const hookRunner = makeMockHookRunner({
      runBeforeLlmCall: vi.fn().mockResolvedValue({ messages: [] }),
    });

    const streamFn = vi.fn().mockResolvedValue(mockStream);
    const wrapped = wrapStreamFnWithHooks(streamFn, {
      hookRunner,
      agentCtx,
      iterationRef: { current: 1 },
      modelId: "gpt-4",
    });

    await wrapped("gpt-4" as unknown as Model<Api>, makeBaseContext() as unknown as Context, {});

    // messages: [] is an explicit "clear history" — not "no change"
    const passedContext = streamFn.mock.calls[0][1];
    expect(passedContext.messages).toEqual([]);
  });
});
