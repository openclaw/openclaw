import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("saved assistant occurrence settlement", () => {
  it.each([
    { label: "failed after sleep", barrier: true, commentary: false },
    { label: "failed with multiple final items", barrier: false, commentary: false },
    { label: "failed after commentary", barrier: false, commentary: true },
  ])("defers $label lifecycle terminal ownership", async ({ barrier, commentary }) => {
    const onRunAgentEvent = vi.fn();
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const error = "codex exploded";
    const target = {
      agentId: "main",
      sessionKey: params.sessionKey!,
      sessionId: params.sessionId,
      storePath: path.join(tempDir, "agents/main/sessions/sessions.json"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: params.sessionId, updatedAt: Date.now() },
    });
    params.sessionTarget = target;
    params.deferTerminalLifecycle = true;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (commentary) {
      await harness.notify(
        itemNotification("item/completed", {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "Earlier commentary",
          status: "completed",
        }),
      );
    } else {
      const earlier = {
        id: "earlier-final",
        type: "agentMessage",
        phase: "final_answer",
        text: "Earlier final",
      };
      await harness.notify(itemNotification("item/started", { ...earlier, text: "" }));
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: earlier.id,
          delta: earlier.text,
        },
      });
      await harness.notify(itemNotification("item/completed", earlier));
      if (barrier) {
        const sleep = { id: "sleep-1", type: "sleep", durationMs: 250 };
        await harness.notify(itemNotification("item/started", sleep));
        await harness.notify(itemNotification("item/completed", sleep));
      }
      await harness.notify(
        itemNotification("item/started", {
          id: "msg-1",
          type: "agentMessage",
          phase: "final_answer",
          text: "",
        }),
      );
    }
    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello back",
      },
    });
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "failed",
        items: [],
        error: { message: error },
      }),
    );
    const result = await run;

    const lifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents.map((event) => event.data.phase)).toEqual([
      "start",
      "model",
      "finishing",
    ]);
    expect(lifecycleEvents.at(-1)?.data.error).toBe(error);
    expect(result.assistantTranscriptIdempotencyKey).toBe(
      "codex-app-server:thread-1:turn-1:assistant",
    );
    expect(lifecycleEvents.at(-1)?.data.assistantTranscriptIdempotencyKey).toBe(
      result.assistantTranscriptIdempotencyKey,
    );
    if (!commentary) {
      const selectedText = barrier ? "hello back" : "Earlier final\n\nhello back";
      expect(result.assistantTexts.join("\n\n")).toBe(selectedText);
      const assistantEvents = onRunAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "assistant");
      expect(assistantEvents.at(-1)?.data).toEqual({
        text: selectedText,
        itemId: result.assistantTranscriptIdempotencyKey,
        replace: true,
        replaceable: true,
      });
    }
  });
});
