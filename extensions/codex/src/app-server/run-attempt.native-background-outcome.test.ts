import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("native background command outcomes", () => {
  it.each([
    "retained",
    "foreign item",
    "foreign process",
    "orphan",
    "completion during inventory",
    "revoked during inventory",
    "inventory unavailable",
  ] as const)("projects the native owner outcome: %s", async (scenario) => {
    const accepted = createDeferred<void>();
    const abort = new AbortController();
    const params = createTestParams();
    params.abortSignal = abort.signal;
    params.onExecutionPhase = ({ phase }) => {
      if (phase === "turn_accepted") {
        accepted.resolve();
      }
    };
    const command = {
      type: "commandExecution",
      id: "retained-command",
      command: "synthetic-controlled-command",
      cwd: "/workspace",
      processId: "52627",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const harness = createStartedThreadHarness(async (method, input) => {
      if (method !== "thread/backgroundTerminals/list") {
        return undefined;
      }
      expect(input).toMatchObject({ threadId: "thread-1" });
      if (abort.signal.aborted) {
        return { data: [], nextCursor: null };
      }
      if (scenario === "inventory unavailable") {
        throw new Error("Synthetic inventory unavailable");
      }
      if (scenario === "completion during inventory") {
        await harness.notify(
          itemNotification("item/completed", {
            ...command,
            status: "failed",
            exitCode: 7,
            aggregatedOutput: "Synthetic command failed after yielding",
            durationMs: 1,
          }),
        );
      }
      if (scenario === "revoked during inventory") {
        abort.abort(new Error("Synthetic source revoked during inventory"));
      }
      return {
        data:
          scenario === "orphan"
            ? []
            : [
                {
                  itemId: scenario === "foreign item" ? "another-command" : command.id,
                  processId: scenario === "foreign process" ? "another-process" : command.processId,
                },
              ],
        nextCursor: null,
      };
    });
    const run = runCodexAppServerAttempt(params);
    try {
      await Promise.race([
        accepted.promise,
        run.then(() => {
          throw new Error("Attempt ended before native turn acceptance");
        }),
      ]);
      await harness.notify(itemNotification("item/started", command));
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "completed",
          items: [
            {
              id: "answer",
              type: "agentMessage",
              phase: "final_answer",
              text: "Retained handle 52627.",
            },
          ],
        }),
      );
      const result = await run;
      const tool = result.messagesSnapshot.find(
        (message) => message.role === "toolResult" && message.toolCallId === command.id,
      );
      if (scenario === "retained") {
        expect(tool).toMatchObject({
          isError: false,
          content: [{ type: "text", text: expect.stringContaining("still running") }],
          __openclaw: { toolOutput: { outcome: "unknown" } },
        });
        expect(JSON.stringify(tool)).toContain("52627");
      } else if (scenario === "completion during inventory") {
        expect(tool).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "Synthetic command failed after yielding" }],
        });
        expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
      } else {
        expect(tool).toMatchObject({ isError: true });
        expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
      }
    } finally {
      abort.abort(new Error("fixture cleanup"));
      harness.close();
      await Promise.allSettled([run]);
    }
  });
});
