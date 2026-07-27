import { withAgentHarnessTaskRuntimeTestState } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

describe("Codex native execution receipt persistence", () => {
  it("persists a completed runtime item through the task completion gate", async () => {
    await withAgentHarnessTaskRuntimeTestState(
      {
        label: "codex-native-receipts",
        requesterSessionKey: "agent:main:test",
        runtime: "subagent",
        taskKind: "codex-native-subagent",
        runIdPrefix: "codex-thread:",
      },
      (runtime) => {
        const mirror = new CodexNativeSubagentTaskMirror(
          {
            parentThreadId: "parent-thread",
            now: () => 10_000,
            isRelayHealthy: () => true,
          },
          runtime,
        );
        mirror.handleNotification({
          method: "thread/started",
          params: {
            thread: {
              id: "child-thread",
              status: { type: "active", activeFlags: [] },
              source: {
                subAgent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1 } },
              },
            },
          },
        });
        mirror.handleNotification({
          method: "item/completed",
          params: {
            threadId: "child-thread",
            item: {
              id: "change-1",
              type: "fileChange",
              status: "completed",
              changes: [{ path: "src/worker.ts", kind: "update" }],
            },
          },
        });

        expect(runtime.listExecutionReceipts("codex-thread:child-thread")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "diff",
              status: "ok",
              detail: expect.objectContaining({ readable: true }),
            }),
          ]),
        );
        expect(
          runtime.evaluateExecutionGate({
            runId: "codex-thread:child-thread",
            gate: "running_code",
            now: 10_000,
          }),
        ).toEqual(expect.objectContaining({ ok: false, missing: ["branch"] }));
        mirror.dispose();
      },
    );
  });
});
