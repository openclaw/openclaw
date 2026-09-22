import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("saved assistant occurrence settlement", () => {
  it.each([
    { label: "completed", status: "completed" as const, error: undefined },
    { label: "failed", status: "failed" as const, error: "codex exploded" },
    {
      label: "failed after commentary",
      status: "failed" as const,
      error: "codex exploded",
      commentary: true,
    },
    {
      label: "failed without persistence",
      status: "failed" as const,
      error: "codex exploded",
      noReceipt: true,
    },
    {
      label: "failed after sleep",
      status: "failed" as const,
      error: "codex exploded",
      barrier: true,
    },
    {
      label: "failed with multiple final items",
      status: "failed" as const,
      error: "codex exploded",
      multiple: true,
    },
  ])(
    "defers $label lifecycle terminal ownership",
    async ({ status, error, commentary, barrier, multiple, noReceipt }) => {
      const onRunAgentEvent = vi.fn();
      const sessionFile = path.join(tempDir, `deferred-${status}.jsonl`);
      const workspaceDir = path.join(tempDir, `workspace-${status}`);
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
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
      if (!noReceipt) {
        params.sessionTarget = target;
      }
      params.deferTerminalLifecycle = true;
      params.onAgentEvent = onRunAgentEvent;
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");

      if (commentary) {
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "commentary-1",
              type: "agentMessage",
              phase: "commentary",
              text: "Earlier commentary",
              status: "completed",
            },
          },
        });
      }

      if (barrier || multiple) {
        const earlier = {
          id: "earlier-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "Earlier final",
        };
        await harness.notify({
          method: "item/started",
          params: { threadId: "thread-1", turnId: "turn-1", item: { ...earlier, text: "" } },
        });
        await harness.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: earlier.id,
            delta: earlier.text,
          },
        });
        await harness.notify({
          method: "item/completed",
          params: { threadId: "thread-1", turnId: "turn-1", item: earlier },
        });
        if (barrier) {
          const sleep = { id: "sleep-1", type: "sleep", durationMs: 250 };
          await harness.notify({
            method: "item/started",
            params: { threadId: "thread-1", turnId: "turn-1", item: sleep },
          });
          await harness.notify({
            method: "item/completed",
            params: { threadId: "thread-1", turnId: "turn-1", item: sleep },
          });
        }
        await harness.notify({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "msg-1", type: "agentMessage", phase: "final_answer", text: "" },
          },
        });
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
      if (status === "completed") {
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      } else {
        await harness.notify({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status,
              error: { message: error },
            },
          },
        });
      }
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
        noReceipt ? undefined : "codex-app-server:thread-1:turn-1:assistant",
      );
      expect(lifecycleEvents.at(-1)?.data.assistantTranscriptIdempotencyKey).toBe(
        result.assistantTranscriptIdempotencyKey,
      );
      if (barrier || multiple) {
        const selectedText = multiple ? "Earlier final\n\nhello back" : "hello back";
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
    },
  );
});
