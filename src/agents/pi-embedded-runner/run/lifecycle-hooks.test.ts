import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { triggerInternalHook } = vi.hoisted(() => ({
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("../../../hooks/internal-hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../../../hooks/internal-hooks.js")>(
    "../../../hooks/internal-hooks.js",
  );
  return {
    ...actual,
    triggerInternalHook,
  };
});

import {
  createInternalAgentHookEmitter,
  createResponseLifecycleTracker,
  emitThinkingEnd,
  emitThinkingStart,
} from "./lifecycle-hooks.js";

type HookEventRecord = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
};

describe("lifecycle hooks", () => {
  beforeEach(() => {
    triggerInternalHook.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits thinking lifecycle hooks with session fallback and error context", async () => {
    const warn = vi.fn();
    const emitInternalAgentHook = createInternalAgentHookEmitter(
      {
        sessionKey: "",
        runId: "run-1",
      },
      warn,
    );
    const lifecycleParams = {
      sessionId: "session-1",
      runId: "run-1",
      provider: "openai",
      modelId: "gpt-5",
      messageProvider: "telegram",
      messageChannel: "telegram",
    } as const;

    await emitThinkingStart(lifecycleParams, emitInternalAgentHook);
    vi.advanceTimersByTime(275);
    await emitThinkingEnd({
      lifecycleParams,
      emitInternalAgentHook,
      promptStartedAt: Date.now() - 275,
      promptError: new Error("prompt failed"),
      formatError: (err) => String(err),
    });

    expect(warn).not.toHaveBeenCalled();
    expect(triggerInternalHook).toHaveBeenCalledTimes(2);

    const recordedCalls = triggerInternalHook.mock.calls as unknown as Array<[HookEventRecord]>;
    const thinkingStart = recordedCalls[0]?.[0];
    const thinkingEnd = recordedCalls[1]?.[0];
    expect(thinkingStart?.type).toBe("agent");
    expect(thinkingStart?.action).toBe("thinking:start");
    expect(thinkingStart?.sessionKey).toBe("run:run-1");
    expect(thinkingStart?.context).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
      messageProvider: "telegram",
      messageChannel: "telegram",
    });
    expect(thinkingEnd?.type).toBe("agent");
    expect(thinkingEnd?.action).toBe("thinking:end");
    expect(thinkingEnd?.context).toMatchObject({
      sessionId: "session-1",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5",
      durationMs: 275,
      error: "Error: prompt failed",
    });
  });

  it("emits response hooks only once when assistant output begins", async () => {
    const warn = vi.fn();
    const onAssistantMessageStart = vi.fn();
    const emitInternalAgentHook = createInternalAgentHookEmitter(
      {
        sessionKey: "agent:main:session-1",
        runId: "run-2",
      },
      warn,
    );
    const tracker = createResponseLifecycleTracker({
      params: {
        sessionId: "session-1",
        runId: "run-2",
        provider: "openai",
        modelId: "gpt-5",
        messageProvider: "discord",
        messageChannel: "discord",
      },
      emitInternalAgentHook,
      onAssistantMessageStart,
      formatError: (err) => String(err),
    });

    await tracker.emitResponseStartIfNeeded(false);
    expect(triggerInternalHook).not.toHaveBeenCalled();

    tracker.handleAssistantMessageStart();
    vi.advanceTimersByTime(120);
    await tracker.emitResponseStartIfNeeded(true);
    await tracker.emitResponseEnd(undefined);

    expect(warn).not.toHaveBeenCalled();
    expect(onAssistantMessageStart).toHaveBeenCalledTimes(1);
    expect(triggerInternalHook).toHaveBeenCalledTimes(2);
    const recordedCalls = triggerInternalHook.mock.calls as unknown as Array<[HookEventRecord]>;
    const responseStart = recordedCalls[0]?.[0];
    const responseEnd = recordedCalls[1]?.[0];

    expect(responseStart).toMatchObject({
      type: "agent",
      action: "response:start",
      sessionKey: "agent:main:session-1",
      context: {
        sessionId: "session-1",
        runId: "run-2",
        provider: "openai",
        model: "gpt-5",
        messageProvider: "discord",
        messageChannel: "discord",
      },
    });
    expect(responseEnd).toMatchObject({
      type: "agent",
      action: "response:end",
      context: {
        sessionId: "session-1",
        runId: "run-2",
        provider: "openai",
        model: "gpt-5",
        durationMs: 120,
        error: undefined,
      },
    });
  });
});
