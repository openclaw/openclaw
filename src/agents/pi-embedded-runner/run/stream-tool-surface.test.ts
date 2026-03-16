import { describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithToolSurface } from "./stream-tool-surface.js";

type WrappedFn = ReturnType<typeof wrapStreamFnWithToolSurface>;
type Model = Parameters<WrappedFn>[0];
type LlmContext = Parameters<WrappedFn>[1];
type SimpleStreamOptions = Parameters<WrappedFn>[2];

describe("wrapStreamFnWithToolSurface", () => {
  it("filters tools via hook before calling inner streamFn", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolSurface: vi.fn().mockResolvedValue({
        tools: [{ name: "read", description: "read", parameters: {} }],
      }),
    };

    const wrapped = wrapStreamFnWithToolSurface(
      innerFn as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[0],
      hookRunner as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[1],
      { agentId: "test", sessionKey: "test-sk" },
    );

    const model = { provider: "anthropic" };
    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [
        { name: "read", description: "read", parameters: {} },
        { name: "message", description: "message", parameters: {} },
      ],
    };
    const options = {};

    await wrapped(
      model as unknown as Model,
      context as unknown as LlmContext,
      options as unknown as SimpleStreamOptions,
    );

    expect(hookRunner.runBeforeToolSurface).toHaveBeenCalledWith(
      { tools: context.tools },
      { agentId: "test", sessionKey: "test-sk" },
    );

    const passedContext = innerFn.mock.calls[0][1] as { tools: Array<{ name: string }> };
    expect(passedContext.tools).toHaveLength(1);
    expect(passedContext.tools[0].name).toBe("read");
  });

  it("passes through unmodified when tools array is empty", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      runBeforeToolSurface: vi.fn(),
    };

    const wrapped = wrapStreamFnWithToolSurface(
      innerFn as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[0],
      hookRunner as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[1],
      {},
    );

    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [],
    };

    await wrapped(
      {} as unknown as Model,
      context as unknown as LlmContext,
      {} as unknown as SimpleStreamOptions,
    );

    expect(hookRunner.runBeforeToolSurface).not.toHaveBeenCalled();
    expect(innerFn).toHaveBeenCalledWith({}, context, {});
  });

  it("passes through when hook returns no tools override", async () => {
    const innerFn = vi.fn().mockResolvedValue({ type: "response" });
    const hookRunner = {
      hasHooks: vi.fn().mockReturnValue(true),
      runBeforeToolSurface: vi.fn().mockResolvedValue(undefined),
    };

    const wrapped = wrapStreamFnWithToolSurface(
      innerFn as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[0],
      hookRunner as unknown as Parameters<typeof wrapStreamFnWithToolSurface>[1],
      {},
    );

    const context = {
      systemPrompt: "test",
      messages: [],
      tools: [{ name: "read", description: "read", parameters: {} }],
    };

    await wrapped(
      {} as unknown as Model,
      context as unknown as LlmContext,
      {} as unknown as SimpleStreamOptions,
    );

    const passedContext = innerFn.mock.calls[0][1] as { tools: Array<{ name: string }> };
    expect(passedContext.tools).toHaveLength(1);
  });
});
