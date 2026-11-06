// Copilot tests cover native SDK hook compatibility.
import { describe, expect, it, vi } from "vitest";
import { createHooksBridge, type CopilotHooksConfig } from "./hooks-bridge.js";

describe("createHooksBridge", () => {
  const hookBase = {
    sessionId: "runtime-session",
    timestamp: new Date(0),
    cwd: "/",
    workingDirectory: "/",
  };

  it("returns undefined when no handlers are configured", () => {
    expect(createHooksBridge()).toBeUndefined();
    expect(createHooksBridge({})).toBeUndefined();
    expect(createHooksBridge({ onHookError: () => undefined })).toBeUndefined();
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

  it("never lets the error notifier throw into the SDK", async () => {
    const hooks = createHooksBridge({
      onSessionEnd: () => {
        throw new Error("hook boom");
      },
      onHookError: () => {
        throw new Error("notifier boom");
      },
    })!;

    await expect(
      hooks.onSessionEnd!({ ...hookBase, reason: "complete" }, { sessionId: "s" }),
    ).resolves.toBeUndefined();
  });

  it("preserves all supported SDK hook handlers", () => {
    const config: CopilotHooksConfig = {
      onPreToolUse: vi.fn().mockResolvedValue({ suppressOutput: true }),
      onPreMcpToolCall: vi.fn(),
      onPostToolUse: vi.fn().mockResolvedValue({ suppressOutput: false }),
      onPostToolUseFailure: vi.fn(),
      onUserPromptSubmitted: vi.fn().mockResolvedValue({ modifiedPrompt: "trimmed" }),
      onSessionStart: vi.fn().mockResolvedValue({ additionalContext: "context" }),
      onSessionEnd: vi.fn().mockResolvedValue({ sessionSummary: "done" }),
      onErrorOccurred: vi.fn().mockResolvedValue({ errorHandling: "retry" as const }),
    };
    const hooks = createHooksBridge(config)!;

    expect(typeof hooks.onPreToolUse).toBe("function");
    expect(typeof hooks.onPreMcpToolCall).toBe("function");
    expect(typeof hooks.onPostToolUse).toBe("function");
    expect(typeof hooks.onPostToolUseFailure).toBe("function");
    expect(typeof hooks.onUserPromptSubmitted).toBe("function");
    expect(typeof hooks.onSessionStart).toBe("function");
    expect(typeof hooks.onSessionEnd).toBe("function");
    expect(typeof hooks.onErrorOccurred).toBe("function");
  });
});
