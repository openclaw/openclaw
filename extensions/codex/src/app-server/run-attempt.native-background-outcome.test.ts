import { expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import type { JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  answerCompleted,
  retainSourceAuthority,
  runningCommand,
} from "./run-attempt-continuity.test-support.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it.each([
  ["retained", "52627"],
  ["foreign item", "52627"],
  ["foreign process", "52627"],
  ["completion during inventory", "52627"],
  ["revoked during inventory", "52627"],
  ["inventory unavailable", "52627"],
  ["retained", null],
] as const)("native background outcome: %s (%s)", async (scenario, startProcessId) => {
  const abort = new AbortController();
  const params = createTestParams();
  params.abortSignal = abort.signal;
  const source = new AbortController();
  const releaseSource = vi.fn();
  params.hostCapabilities = {
    ...params.hostCapabilities,
    retainSourceAuthority: retainSourceAuthority(source.signal, releaseSource),
  };
  const command = runningCommand(
    "retained-command",
    "synthetic-controlled-command",
    startProcessId,
  );
  const failedOutput = "Synthetic command failed after yielding";
  const complete = (patch: JsonObject): Promise<void> =>
    harness.notify(itemNotification("item/completed", { ...command, ...patch }));
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
      await complete({
        processId: "52627",
        status: "failed",
        exitCode: 7,
        aggregatedOutput: failedOutput,
        durationMs: 1,
      });
    }
    if (scenario === "revoked during inventory") {
      abort.abort(new Error("Synthetic source revoked during inventory"));
    }
    return {
      data: [
        {
          itemId: scenario === "foreign item" ? "another-command" : command.id,
          processId: scenario === "foreign process" ? "another-process" : "52627",
        },
      ],
      nextCursor: null,
    };
  });
  const run = runCodexAppServerAttempt(params);
  try {
    await run.waitForTurnAccepted();
    await harness.notify(itemNotification("item/started", command));
    await harness.notify(answerCompleted("Retained handle 52627."));
    const tool = (await run).messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === command.id,
    );
    if (scenario === "retained") {
      expect(tool).toMatchObject({
        isError: false,
        content: [{ type: "text", text: expect.stringContaining("still running") }],
        __openclaw: { toolOutput: { outcome: "unknown" } },
      });
      expect(JSON.stringify(tool)).toContain("52627");
      const unsubscribe = { method: "thread/unsubscribe", params: { threadId: "thread-1" } };
      const evictIdleThreads = async (phase: string) => {
        for (let index = 0; index < 65; index += 1) {
          await retainCodexAppServerLiveThread(harness.client, `idle-${phase}-${index}`);
        }
      };
      await evictIdleThreads("before");
      expect(harness.requests).not.toContainEqual(unsubscribe);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "foreign-turn",
          item: { ...command, processId: "52627" },
        },
      });
      await complete({ processId: "foreign-process" });
      await evictIdleThreads("foreign");
      expect(harness.requests).not.toContainEqual(unsubscribe);
      if (startProcessId === null) {
        source.abort(new Error("Synthetic retained source revoked"));
      } else {
        await complete({ processId: "52627", status: "completed", exitCode: 0 });
      }
      await evictIdleThreads("after");
      expect(harness.requests).toContainEqual(unsubscribe);
      expect(releaseSource).toHaveBeenCalled();
    } else {
      expect(tool).toMatchObject({ isError: true });
      if (scenario === "completion during inventory") {
        expect(tool).toMatchObject({ content: [{ type: "text", text: failedOutput }] });
      }
      expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
    }
  } finally {
    source.abort(new Error("fixture cleanup"));
    abort.abort(new Error("fixture cleanup"));
    harness.close();
    await Promise.allSettled([run]);
  }
});
