import type { SessionEvent } from "@github/copilot-sdk";
import { onAgentEvent as subscribeAgentEvents } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import { attachEventBridge, type SessionLike } from "./event-bridge.js";

type ToolEventFixtures = {
  createFakeSession: () => SessionLike & {
    emit: (eventType: string, event: SessionEvent) => void;
  };
  makeEvent: (type: string, data: Record<string, unknown>) => SessionEvent;
};

export function registerCopilotToolEventTests({ createFakeSession, makeEvent }: ToolEventFixtures) {
  it("fans prepared executed outcomes to bus and callback without changing SDK counters", async () => {
    const session = createFakeSession();
    const emit = (type: string, data: Record<string, unknown>) =>
      session.emit(type, makeEvent(type, data));
    const runId = "copilot-activity";
    const bus: Record<string, unknown>[] = [];
    const direct = vi.fn();
    const dispose = subscribeAgentEvents((event) => {
      if (event.runId === runId && event.stream === "item") {
        bus.push(event.data);
      }
    });
    const bridge = attachEventBridge(session, {
      runId,
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
      onAgentEvent: direct,
    });
    try {
      const raw = { content: "raw result" };
      for (const [toolCallId, requestedAction, executedAction, isError] of [
        ["mutation", "poll", "kill", false],
        ["quiet", "kill", "poll", false],
        ["failed", "poll", "poll", true],
      ] as const) {
        const tool = { toolCallId, toolName: "process" };
        emit("tool.execution_start", { ...tool, arguments: { action: requestedAction } });
        bridge.completeTool({ ...tool, args: { action: executedAction }, isError });
        emit("tool.execution_complete", { toolCallId, success: !isError, result: raw });
      }
      await bridge.awaitAgentEventChain();
      expect(bus).toHaveLength(6);
      expect(direct.mock.calls).toHaveLength(bus.length);
      for (const [index, [event]] of direct.mock.calls.entries()) {
        expect(event.data).toBe(bus[index]);
      }
      const ended = bus.filter((item) => item.phase === "end");
      expect(ended.map((item) => Boolean(item.hideFromChannelProgress))).toEqual([
        false,
        true,
        false,
      ]);
      expect(bridge.snapshot()).toMatchObject({ startedCount: 3, completedCount: 3 });
      const root = { toolCallId: "root-catalog", toolName: "tool_search" };
      emit("tool.execution_start", { ...root, arguments: {} });
      const nested = { parentToolCallId: root.toolCallId, isError: false };
      const approval = { approvalId: "approval", approvalSlug: "approve" };
      for (const [toolCallId, toolName, result, expected] of [
        ["root-nested", "read", undefined, { toolCallId: "root-nested", status: "completed" }],
        [
          "pending-exec",
          "exec",
          { details: { status: "approval-pending", ...approval } },
          { status: "blocked", ...approval },
        ],
      ] as const) {
        bridge.completeTool({ ...nested, toolCallId, toolName, result });
        await bridge.awaitAgentEventChain();
        expect(bus.at(-1)).toMatchObject(expected);
      }
    } finally {
      bridge.detach();
      dispose();
    }
  });
}
