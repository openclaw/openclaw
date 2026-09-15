import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import * as attemptTools from "./run-attempt-tool-setup.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

describe("Codex attempt media yield and final answer settlement", () => {
  it("does not classify a completed final answer as paused when background media startup invoked onYield", async () => {
    const toolsSpy = vi.spyOn(attemptTools, "prepareCodexAttemptTools");
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-media-yield.jsonl"),
      path.join(tempDir, "workspace-media-yield"),
    );
    params.sessionKey = "agent:main:subagent:media-child";
    params.runtimePlan = createCodexRuntimePlanFixture();
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    const trajectoryEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
    params.hostCapabilities = {
      ...params.hostCapabilities,
      trajectory: {
        recordEvent: (type, data) => {
          trajectoryEvents.push({ type, data });
        },
        flush: async () => undefined,
      },
    };

    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      const preparedTools = await toolsSpy.mock.results[0]?.value;
      if (!preparedTools) {
        throw new Error("Expected prepared Codex attempt tools");
      }

      // Simulate background media generation async start callback setting yieldDetected
      preparedTools.toolState.yieldDetected = true;
      preparedTools.toolState.yieldMessage = "image_generate background task started";

      // Model finishes working and produces a terminal assistant answer
      const answerText = "Here is your generated image on disk.";
      await harness.notify(
        itemNotification("item/completed", {
          type: "agentMessage",
          id: "terminal-answer",
          phase: "final_answer",
          text: answerText,
        }),
      );

      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;

      // Completed final answer outranks the media start yield signal
      expect(result.yieldDetected).toBe(false);
      expect(result.assistantTexts).toEqual([answerText]);

      const terminalLifecycle = onAgentEvent.mock.calls
        .map(([call]) => call as { stream?: string; data?: Record<string, unknown> })
        .find((event) => event.stream === "lifecycle" && event.data?.phase === "end");

      expect(terminalLifecycle).toBeDefined();
      expect(terminalLifecycle?.data?.yielded).toBeUndefined();
      expect(terminalLifecycle?.data?.livenessState).toBeUndefined();

      // Trajectory completion and session.ended record non-yielded status
      const modelCompleted = trajectoryEvents.find((e) => e.type === "model.completed");
      expect(modelCompleted?.data?.yielded).toBeUndefined();
      expect(modelCompleted?.data?.yieldDetected).toBe(false);

      const sessionEnded = trajectoryEvents.find((e) => e.type === "session.ended");
      expect(sessionEnded?.data?.yieldDetected).toBe(false);
      expect(sessionEnded?.data?.status).toBe("success");
    } finally {
      toolsSpy.mockRestore();
    }
  });

  it("preserves genuine sessions_yield as a paused continuation", async () => {
    const harness = createStartedThreadHarness();
    const params = createParams(
      path.join(tempDir, "session-genuine-yield.jsonl"),
      path.join(tempDir, "workspace-genuine-yield"),
    );
    params.sessionKey = "agent:main:subagent:genuine-yield-child";
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.toolsAllow = ["sessions_yield"];
    setCodexTestModelSupportsTools(params, true);
    const onAgentEvent = vi.fn();
    params.onAgentEvent = onAgentEvent;
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "genuine-yield-sessions.json"),
      "subagent:genuine-yield-child",
    );

    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    const yieldResponse = await harness.handleServerRequest({
      id: "request-sessions-yield",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-genuine-yield",
        namespace: null,
        tool: "sessions_yield",
        arguments: {
          waitFor: "message",
          message: "Waiting for incoming continuation",
          acknowledgment: "Pausing",
        },
      },
    });
    expect(yieldResponse).toMatchObject({ success: true, contentItems: expect.any(Array) });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.yieldDetected).toBe(true);
    expect(result.yieldAcknowledgment).toBe("Pausing");

    const terminalLifecycle = onAgentEvent.mock.calls
      .map(([call]) => call as { stream?: string; data?: Record<string, unknown> })
      .find((event) => event.stream === "lifecycle" && event.data?.phase === "end");

    expect(terminalLifecycle?.data).toMatchObject({
      phase: "end",
      yielded: true,
      livenessState: "paused",
      stopReason: "end_turn",
    });
  });
});
