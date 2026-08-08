import { beforeEach, describe, expect, it, vi } from "vitest";

const { createRuntimeLlmMock, runtimeLlmCompleteMock } = vi.hoisted(() => ({
  createRuntimeLlmMock: vi.fn(),
  runtimeLlmCompleteMock: vi.fn(),
}));

vi.mock("../../plugins/runtime/runtime-llm.runtime.js", () => ({
  createRuntimeLlm: createRuntimeLlmMock,
}));

import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";

describe("resolveContextEngineCapabilities", () => {
  beforeEach(() => {
    runtimeLlmCompleteMock.mockReset().mockResolvedValue({ content: [] });
    createRuntimeLlmMock.mockReset().mockReturnValue({ complete: runtimeLlmCompleteMock });
  });

  it("does not mark an unused LLM capability", () => {
    const onLlmCompleteInvocation = vi.fn();

    resolveContextEngineCapabilities({
      purpose: "context-engine.test",
      onLlmCompleteInvocation,
    });

    expect(createRuntimeLlmMock).not.toHaveBeenCalled();
    expect(onLlmCompleteInvocation).not.toHaveBeenCalled();
  });

  it("marks immediately before every LLM completion invocation", async () => {
    const events: string[] = [];
    const onLlmCompleteInvocation = vi.fn(() => events.push("mark"));
    runtimeLlmCompleteMock.mockImplementation(async () => {
      events.push("complete");
      return { content: [] };
    });
    const capabilities = resolveContextEngineCapabilities({
      purpose: "context-engine.test",
      onLlmCompleteInvocation,
    });

    await capabilities.llm?.complete({ prompt: "first" } as never);
    await capabilities.llm?.complete({ prompt: "second" } as never);

    expect(onLlmCompleteInvocation).toHaveBeenCalledTimes(2);
    expect(runtimeLlmCompleteMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["mark", "complete", "mark", "complete"]);
  });

  it("marks a failing LLM completion invocation", async () => {
    const onLlmCompleteInvocation = vi.fn();
    const runtimeError = new Error("completion failed");
    runtimeLlmCompleteMock.mockRejectedValueOnce(runtimeError);
    const capabilities = resolveContextEngineCapabilities({
      purpose: "context-engine.test",
      onLlmCompleteInvocation,
    });

    await expect(capabilities.llm?.complete({ prompt: "fail" } as never)).rejects.toBe(
      runtimeError,
    );

    expect(onLlmCompleteInvocation).toHaveBeenCalledOnce();
  });

  it("does not mark when runtime capability creation fails before invocation", async () => {
    const onLlmCompleteInvocation = vi.fn();
    const runtimeError = new Error("runtime unavailable");
    createRuntimeLlmMock.mockImplementationOnce(() => {
      throw runtimeError;
    });
    const capabilities = resolveContextEngineCapabilities({
      purpose: "context-engine.test",
      onLlmCompleteInvocation,
    });

    await expect(capabilities.llm?.complete({ prompt: "fail" } as never)).rejects.toBe(
      runtimeError,
    );

    expect(onLlmCompleteInvocation).not.toHaveBeenCalled();
    expect(runtimeLlmCompleteMock).not.toHaveBeenCalled();
  });
});
