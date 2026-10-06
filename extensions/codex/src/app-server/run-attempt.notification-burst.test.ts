import { describe, expect, it } from "vitest";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  createTestParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex app-server notification bursts", () => {
  it("drains bound command output without one macrotask per notification", async () => {
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    const command = {
      id: "cmd-burst",
      type: "commandExecution",
      command: "generate realistic output burst",
      cwd: params.workspaceDir,
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: 20,
    };
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify(
      itemNotification("item/started", {
        ...command,
        status: "inProgress",
        exitCode: null,
        durationMs: null,
      }),
    );

    const notificationCount = 128;
    const handledOrder: number[] = [];
    const notifications = Array.from({ length: notificationCount }, (_, index) =>
      harness
        .notify({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-burst",
            delta: `${index.toString().padStart(3, "0")}:${"x".repeat(8_188)}`,
          },
        })
        .then(() => {
          handledOrder.push(index);
        }),
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(handledOrder).toHaveLength(notificationCount);
    await Promise.all(notifications);
    expect(handledOrder).toEqual(Array.from({ length: notificationCount }, (_, index) => index));

    await harness.notify(
      itemNotification("item/completed", {
        ...command,
        processId: 42,
        durationMs: 20,
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(JSON.stringify(result.messagesSnapshot)).toContain('"toolCallId":"cmd-burst"');
  });
});
