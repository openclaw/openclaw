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
      for (const [toolCallId, requestedAction, executedAction, isError] of [
        ["mutation", "poll", "kill", false],
        ["quiet", "kill", "poll", false],
        ["failed", "poll", "poll", true],
      ] as const) {
        session.emit(
          "tool.execution_start",
          makeEvent("tool.execution_start", {
            toolCallId,
            toolName: "process",
            arguments: { action: requestedAction },
          }),
        );
        bridge.completeTool({
          toolCallId,
          toolName: "process",
          args: { action: executedAction },
          isError,
        });
        session.emit(
          "tool.execution_complete",
          makeEvent("tool.execution_complete", {
            toolCallId,
            success: !isError,
            result: { content: "raw result" },
          }),
        );
      }
      await bridge.awaitAgentEventChain();
      expect(bus).toHaveLength(6);
      expect(direct.mock.calls.map(([event]) => event.data)).toEqual(bus);
      for (const [index, call] of direct.mock.calls.entries()) {
        expect(call[0].data).toBe(bus[index]);
      }
      expect(
        bus
          .filter((item) => item.phase === "end")
          .map((item) => Boolean(item.hideFromChannelProgress)),
      ).toEqual([false, true, false]);
      expect(bridge.snapshot()).toMatchObject({ startedCount: 3, completedCount: 3 });
      session.emit(
        "tool.execution_start",
        makeEvent("tool.execution_start", {
          toolCallId: "root-catalog",
          toolName: "tool_search",
          arguments: {},
        }),
      );
      bridge.completeTool({
        toolCallId: "root-nested",
        parentToolCallId: "root-catalog",
        toolName: "read",
        isError: false,
      });
      await bridge.awaitAgentEventChain();
      expect(bus.at(-1)).toMatchObject({ toolCallId: "root-nested", status: "completed" });
      bridge.completeTool({
        toolCallId: "pending-exec",
        parentToolCallId: "root-catalog",
        toolName: "exec",
        isError: false,
        result: {
          details: { status: "approval-pending", approvalId: "approval", approvalSlug: "approve" },
        },
      });
      await bridge.awaitAgentEventChain();
      expect(bus.at(-1)).toMatchObject({
        status: "blocked",
        approvalId: "approval",
        approvalSlug: "approve",
      });
    } finally {
      bridge.detach();
      dispose();
    }
  });

  it("tool.execution_start increments startedCount and pushes toolMetas without meta", () => {
    const session = createFakeSession();
    const bridge = attachEventBridge(session, {
      getSdkSessionId: () => "sdk-session-id",
      isAborted: () => false,
    });

    session.emit(
      "tool.execution_start",
      makeEvent("tool.execution_start", { toolCallId: "call-1", toolName: "bash" }),
    );

    expect(bridge.snapshot()).toEqual({
      assistantTexts: [],
      completedCount: 0,
      lastAssistantEvent: undefined,
      startedCount: 1,
      streamError: undefined,
      toolMetas: [{ toolName: "bash" }],
      usage: undefined,
    });
  });
}
