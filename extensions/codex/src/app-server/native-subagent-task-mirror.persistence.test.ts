import { afterEach, describe, expect, it } from "vitest";
import { createAgentHarnessTaskRuntime } from "../../../../src/plugin-sdk/agent-harness-task-runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { createAgentHarnessTaskRuntimeScope } from "../../../../src/tasks/agent-harness-task-runtime-scope.js";
import { resetTaskRegistryForTests } from "../../../../src/tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  closeOpenClawStateDatabaseForTest();
});

describe("Codex native execution receipt persistence", () => {
  it("persists a completed runtime item through the task completion gate", async () => {
    await withOpenClawTestState({ label: "codex-native-receipts" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const runtime = createAgentHarnessTaskRuntime({
        runtime: "subagent",
        taskKind: "codex-native-subagent",
        scope: createAgentHarnessTaskRuntimeScope({
          requesterSessionKey: "agent:main:test",
        }),
        runIdPrefix: "codex-thread:",
      });
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
    });
  });
});
