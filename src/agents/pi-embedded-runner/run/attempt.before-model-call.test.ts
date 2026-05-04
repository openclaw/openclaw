import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  type MutableSession,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt before_model_call preflight", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  it("runs after preemptive compaction precheck and blocks before prompt submission", async () => {
    const runBeforeModelCall = vi.fn(async () => {
      expect(hoisted.preemptiveCompactionCalls.length).toBeGreaterThan(0);
      return { block: true, blockReason: "state invalid" };
    });
    const runLlmInput = vi.fn(async () => undefined);
    const sessionPrompt = vi.fn(async () => undefined);
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => ["before_model_call", "llm_input"].includes(hookName)),
      runBeforeModelCall,
      runLlmInput,
    });
    const historyMessage: AgentMessage = {
      role: "user",
      content: "prior context",
      timestamp: 1,
    };

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:before-model-call",
      tempPaths,
      sessionMessages: [historyMessage],
      sessionPrompt,
    });

    expect(sessionPrompt).not.toHaveBeenCalled();
    expect(runLlmInput).not.toHaveBeenCalled();
    expect(runBeforeModelCall).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-context-engine-forwarding",
        sessionId: "embedded-session",
        sessionKey: "agent:main:before-model-call",
        provider: "openai",
        model: "gpt-test",
        resolvedRef: "openai/gpt-test",
        harnessId: "pi-embedded",
        prompt: "hello",
        historyMessages: [historyMessage],
        imagesCount: 0,
      }),
      expect.objectContaining({
        runId: "run-context-engine-forwarding",
        sessionId: "embedded-session",
        sessionKey: "agent:main:before-model-call",
      }),
    );
  });

  it("treats block=false as a non-blocking boundary decision", async () => {
    const runBeforeModelCall = vi.fn(async () => ({ block: false }));
    const sessionPrompt = vi.fn(async (session: MutableSession) => {
      session.messages = [
        ...session.messages,
        { role: "assistant", content: "done", timestamp: 2 },
      ];
    });
    hoisted.getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_call"),
      runBeforeModelCall,
    });

    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:before-model-call-continue",
      tempPaths,
      sessionPrompt,
    });

    expect(runBeforeModelCall).toHaveBeenCalledTimes(1);
    expect(sessionPrompt).toHaveBeenCalledWith(expect.any(Object), "hello", undefined);
  });
});
