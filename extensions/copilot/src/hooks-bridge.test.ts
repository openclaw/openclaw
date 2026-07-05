<<<<<<< HEAD
// Copilot tests cover native SDK hook compatibility.
=======
// Copilot tests cover hooks bridge plugin behavior.
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import { describe, expect, it, vi } from "vitest";
import { createHooksBridge, type CopilotHooksConfig } from "./hooks-bridge.js";

describe("createHooksBridge", () => {
  const hookBase = {
    sessionId: "runtime-session",
    timestamp: new Date(0),
    cwd: "/",
    workingDirectory: "/",
  };

<<<<<<< HEAD
  it("returns undefined when no handlers are configured", () => {
    expect(createHooksBridge()).toBeUndefined();
    expect(createHooksBridge({})).toBeUndefined();
    expect(createHooksBridge({ onHookError: () => undefined })).toBeUndefined();
  });

  it("includes only configured native handlers", () => {
    const hooks = createHooksBridge({
      onPreToolUse: vi.fn(),
      onSessionStart: vi.fn(),
    })!;

    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(hooks.onPreMcpToolCall).toBeUndefined();
    expect(hooks.onPostToolUse).toBeUndefined();
    expect(hooks.onPostToolUseFailure).toBeUndefined();
=======
  it("returns undefined when no config is provided", () => {
    expect(createHooksBridge()).toBeUndefined();
  });

  it("returns undefined when config has no handlers", () => {
    expect(createHooksBridge({})).toBeUndefined();
  });

  it("returns undefined when only onHookError is supplied (no real handlers)", () => {
    expect(createHooksBridge({ onHookError: () => undefined })).toBeUndefined();
  });

  it("includes only the handlers that were configured", () => {
    const onPreToolUse = vi.fn();
    const onSessionStart = vi.fn();
    const hooks = createHooksBridge({ onPreToolUse, onSessionStart })!;
    expect(hooks).toBeDefined();
    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(hooks.onPostToolUse).toBeUndefined();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(hooks.onUserPromptSubmitted).toBeUndefined();
    expect(hooks.onSessionEnd).toBeUndefined();
    expect(hooks.onErrorOccurred).toBeUndefined();
  });

  it("forwards arguments and return values from a successful handler", async () => {
    const onPreToolUse = vi
      .fn()
      .mockResolvedValue({ permissionDecision: "allow" as const, additionalContext: "ok" });
    const hooks = createHooksBridge({ onPreToolUse })!;
    const input = {
      ...hookBase,
      cwd: "/tmp",
      workingDirectory: "/tmp",
      toolName: "bash",
      toolArgs: { cmd: "ls" },
    };
<<<<<<< HEAD

    await expect(hooks.onPreToolUse!(input, { sessionId: "sess-1" })).resolves.toEqual({
      permissionDecision: "allow",
      additionalContext: "ok",
    });
    expect(onPreToolUse).toHaveBeenCalledWith(input, { sessionId: "sess-1" });
  });

  it("reports the effective prompt after a native prompt hook completes", async () => {
    const onUserPromptSubmitted = vi.fn().mockResolvedValue({
      additionalContext: "Use the approved repository.",
      modifiedPrompt: "Review the authentication change.",
    });
    const observedPrompt = vi.fn();
    const hooks = createHooksBridge(
      { onUserPromptSubmitted },
      { onUserPromptSubmitted: observedPrompt },
    )!;

    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hello" }, { sessionId: "s" }),
    ).resolves.toEqual({
      additionalContext: "Use the approved repository.",
      modifiedPrompt: "Review the authentication change.",
    });
    expect(observedPrompt).toHaveBeenCalledWith({
      additionalContext: "Use the approved repository.",
      prompt: "Review the authentication change.",
    });
  });

  it("reports the original prompt when a native prompt hook fails", async () => {
    const observedPrompt = vi.fn();
    const hooks = createHooksBridge(
      {
        onUserPromptSubmitted: async () => {
          throw new Error("prompt hook failed");
        },
        onHookError: () => undefined,
      },
      { onUserPromptSubmitted: observedPrompt },
    )!;

    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hello" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
    expect(observedPrompt).toHaveBeenCalledWith({ prompt: "hello" });
  });

  it("isolates synchronous and asynchronous handler failures", async () => {
=======
    const result = await hooks.onPreToolUse!(input, { sessionId: "sess-1" });
    expect(result).toEqual({ permissionDecision: "allow", additionalContext: "ok" });
    expect(onPreToolUse).toHaveBeenCalledTimes(1);
    expect(onPreToolUse).toHaveBeenCalledWith(input, { sessionId: "sess-1" });
  });

  it("isolates synchronous throws: returns undefined and notifies onHookError", async () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const onHookError = vi.fn();
    const hooks = createHooksBridge({
      onPostToolUse: () => {
        throw new Error("post boom");
      },
<<<<<<< HEAD
      onUserPromptSubmitted: async () => {
        throw new Error("prompt boom");
      },
      onHookError,
    })!;

    await expect(
      hooks.onPostToolUse!(
        { ...hookBase, toolName: "x", toolArgs: {}, toolResult: {} as never },
        { sessionId: "s" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      hooks.onUserPromptSubmitted!({ ...hookBase, prompt: "hi" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(2);
  });

  it("never lets the error notifier throw into the SDK", async () => {
=======
      onHookError,
    })!;
    const result = await hooks.onPostToolUse!(
      { ...hookBase, toolName: "x", toolArgs: {}, toolResult: {} as never },
      { sessionId: "s" },
    );
    expect(result).toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]?.[0]).toEqual({
      hookName: "onPostToolUse",
      error: expect.any(Error),
    });
    expect((onHookError.mock.calls[0][0]!.error as Error).message).toBe("post boom");
  });

  it("isolates async rejections: returns undefined and notifies onHookError", async () => {
    const onHookError = vi.fn();
    const hooks = createHooksBridge({
      onUserPromptSubmitted: async () => {
        throw new Error("async boom");
      },
      onHookError,
    })!;
    const result = await hooks.onUserPromptSubmitted!(
      { ...hookBase, prompt: "hi" },
      { sessionId: "s" },
    );
    expect(result).toBeUndefined();
    expect(onHookError).toHaveBeenCalledTimes(1);
    expect(onHookError.mock.calls[0]?.[0]?.hookName).toBe("onUserPromptSubmitted");
  });

  it("uses console.warn as the default onHookError", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const hooks = createHooksBridge({
        onErrorOccurred: () => {
          throw new Error("default-error-handler");
        },
      })!;
      const result = await hooks.onErrorOccurred!(
        { ...hookBase, error: "x", errorContext: "system", recoverable: true },
        { sessionId: "s" },
      );
      expect(result).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain("onErrorOccurred");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("never throws when onHookError itself throws", async () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const hooks = createHooksBridge({
      onSessionEnd: () => {
        throw new Error("hook boom");
      },
      onHookError: () => {
        throw new Error("notifier boom");
      },
    })!;
<<<<<<< HEAD

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    await expect(
      hooks.onSessionEnd!({ ...hookBase, reason: "complete" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
  });

<<<<<<< HEAD
  it("preserves native MCP and failed-tool callbacks", async () => {
    const onPreMcpToolCall = vi.fn();
    const onPostToolUseFailure = vi.fn();
    const hooks = createHooksBridge({
      onPreMcpToolCall,
      onPostToolUseFailure,
    })!;

    await hooks.onPreMcpToolCall!({} as never, { sessionId: "s" });
    await hooks.onPostToolUseFailure!({} as never, { sessionId: "s" });

    expect(onPreMcpToolCall).toHaveBeenCalledTimes(1);
    expect(onPostToolUseFailure).toHaveBeenCalledTimes(1);
  });

  it("preserves all supported SDK hook handlers", () => {
    const config: CopilotHooksConfig = {
      onPreToolUse: vi.fn().mockResolvedValue({ suppressOutput: true }),
      onPreMcpToolCall: vi.fn(),
      onPostToolUse: vi.fn().mockResolvedValue({ suppressOutput: false }),
      onPostToolUseFailure: vi.fn(),
=======
  it("preserves all six SDK hook handlers when supplied", async () => {
    const config: CopilotHooksConfig = {
      onPreToolUse: vi.fn().mockResolvedValue({ suppressOutput: true }),
      onPostToolUse: vi.fn().mockResolvedValue({ suppressOutput: false }),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      onUserPromptSubmitted: vi.fn().mockResolvedValue({ modifiedPrompt: "trimmed" }),
      onSessionStart: vi.fn().mockResolvedValue({ additionalContext: "context" }),
      onSessionEnd: vi.fn().mockResolvedValue({ sessionSummary: "done" }),
      onErrorOccurred: vi.fn().mockResolvedValue({ errorHandling: "retry" as const }),
    };
    const hooks = createHooksBridge(config)!;
<<<<<<< HEAD

    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onPreMcpToolCall).toBe("function");
    expect(typeof hooks.onPostToolUse).toBe("function");
    expect(typeof hooks.onPostToolUseFailure).toBe("function");
=======
    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onPostToolUse).toBe("function");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(typeof hooks.onUserPromptSubmitted).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(typeof hooks.onSessionEnd).toBe("function");
    expect(typeof hooks.onErrorOccurred).toBe("function");
  });
<<<<<<< HEAD
=======

  it("forwards void returns transparently", async () => {
    const hooks = createHooksBridge({
      onSessionStart: () => undefined,
    })!;
    const result = await hooks.onSessionStart!({ ...hookBase, source: "new" }, { sessionId: "s" });
    expect(result).toBeUndefined();
  });

  it("does not invoke unconfigured handlers' isolators", () => {
    const hooks = createHooksBridge({ onPreToolUse: () => undefined })!;
    // ensure the missing handlers are literally absent, not just nullable
    expect("onPostToolUse" in hooks).toBe(false);
    expect("onUserPromptSubmitted" in hooks).toBe(false);
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});
