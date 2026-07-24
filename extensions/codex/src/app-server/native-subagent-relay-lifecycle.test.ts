import { registerNativeHookRelay } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { scheduleCodexNativeHookRelayUnregister } from "./native-hook-relay.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

describe("Codex native subagent relay lifecycle", () => {
  it("records stalled after real parent unregister while connector traffic continues", async () => {
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "child-parent-cleanup",
      sessionId: "session-1",
      runId: "run-1",
      allowedEvents: ["post_tool_use"],
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(relay.isRegistered()).toBe(true);

    const recordExecutionReceipt = vi.fn((params) => ({
      taskId: "task-1",
      sequence: 1,
      recordedAt: 10_000,
      ...params,
    }));
    const recordTaskRunProgressByRunId = vi.fn(() => []);
    const runtime = {
      tryCreateRunningTaskRun: vi.fn((params) => ({ taskId: "task-1", ...params })),
      recordTaskRunProgressByRunId,
      finalizeTaskRunByRunId: vi.fn(() => []),
      recordExecutionReceipt,
    } as unknown as AgentHarnessTaskRuntime;
    const mirror = new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: "parent-thread",
        now: () => 10_000,
        isRelayHealthy: relay.isRegistered,
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

    scheduleCodexNativeHookRelayUnregister({ relay, hookTimeoutSec: 1 });
    nativeHookRelayUnregisterQueue.flush();
    expect(relay.isRegistered()).toBe(false);
    mirror.handleNotification({
      method: "item/completed",
      params: {
        threadId: "child-thread",
        item: { id: "tool-2", type: "webSearch", status: "completed" },
      },
    });

    expect(recordExecutionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "relay_health", status: "error" }),
    );
    expect(recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        progressSummary: "Stalled: native hook relay registration is unavailable.",
      }),
    );
    mirror.dispose();
  });
});
