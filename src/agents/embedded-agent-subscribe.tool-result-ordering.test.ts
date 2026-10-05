import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  AgentActivityItemSchema,
  type AgentActivityItem,
} from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { projectAgentHistoryActivity } from "../infra/agent-activity-events.js";
import { onAgentEvent as subscribeToAgentEvents } from "../infra/agent-events.js";
import { summarizeAgentActivity } from "./agent-activity-presentation.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDeltaAndEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { countActiveToolExecutions } from "./embedded-agent-subscribe.handlers.tools.js";
import {
  createOpenAiResponsesPartial,
  createOpenAiResponsesTextBlock,
} from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { jsonResult } from "./tools/common.js";

type Params = SubscribeEmbeddedAgentSessionParams;
type Recorder = NonNullable<Params["trajectoryRecorder"]>["recordEvent"];
function harness(params: Omit<Params, "session" | "runId"> = {}) {
  const h = createSubscribedSessionHarness({ runId: "tool-ordering", ...params });
  onTestFinished(() => h.subscription.unsubscribe());
  return {
    ...h,
    start(
      toolName: string,
      toolCallId: string,
      args: Record<string, unknown> = {},
      parentToolCallId?: string,
    ) {
      h.emit({ type: "tool_execution_start", toolName, toolCallId, args, parentToolCallId });
    },
    end(toolName: string, toolCallId: string, result: unknown, isError = false) {
      h.emit({ type: "tool_execution_end", toolName, toolCallId, result, isError });
    },
    async finish(text: string) {
      emitAssistantTextDeltaAndEnd({ emit: h.emit, text });
      h.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.subscription.waitForPendingEvents();
    },
  };
}

describe("tool result ordering", () => {
  it("settles subscribed nested dispatch exactly once across repeated exec and wait turns", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const h = createSubscribedCodeModeHarness({ name: "repeated-lifecycle", onBlockReplyFlush });
    const target = pluginToolWithExecute("finish_stage", "Finish one suspended stage", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ finished: true });
    });
    applyCodeModeCatalog({ ...h, tools: [...h.tools, target] });
    const liveItems: AgentActivityItem[] = [];
    const stopEvents = subscribeToAgentEvents((event) => {
      if (
        event.runId === h.runId &&
        event.stream === "item" &&
        Value.Check(AgentActivityItemSchema, event.data)
      ) {
        liveItems.push(event.data);
      }
    });
    try {
      for (let stage = 0; stage < 2; stage += 1) {
        const toolCallId = `code-call-stage-${stage}`;
        const args = { code: 'await yield_control("pause"); return await finish_stage({});' };
        h.sessionManager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: args }],
            stopReason: "toolUse",
          }),
        );
        const result = await h.subscription.runToolLifecycle({
          toolName: "exec",
          toolCallId,
          args,
          execute: async (started) => {
            started();
            return expectDefined(h.tools[0], "Code Mode exec test invariant").execute(
              toolCallId,
              args,
            );
          },
        });
        h.sessionManager.appendMessage({
          role: "toolResult",
          toolCallId,
          toolName: "exec",
          isError: false,
          content: result.content,
          details: result.details,
          timestamp: 0,
        });
        const suspended = resultDetails(result);
        expect(suspended).toMatchObject({ status: "waiting", reason: "yield" });
        const completed = await waitUntilCompleted({
          details: suspended,
          waitTool: expectDefined(h.tools[1], "Code Mode wait test invariant"),
        });
        expect(completed).toMatchObject({ status: "completed", value: { finished: true } });
        expect(countActiveToolExecutions(h.runId)).toBe(0);
      }
      expect(target.execute).toHaveBeenCalledTimes(2);
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(h.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 4,
        completedCount: 4,
        activeCount: 0,
      });
      expect(summarizeAgentActivity(liveItems).total).toBe(4);
      emitAssistantTextDeltaAndEnd({ emit: h.emit, text: "Both stages finished." });
      h.emit({ type: "agent_end", messages: [], willRetry: false });
      await h.subscription.waitForPendingEvents();
      expect(summarizeAgentActivity(liveItems).total).toBe(2);
      expect(h.subscription.getItemLifecycle()).toEqual({
        startedCount: 4,
        completedCount: 4,
        activeCount: 0,
      });
      const history = projectAgentHistoryActivity(
        h.sessionManager
          .getEntries()
          .flatMap((entry) =>
            entry.type === "message" ? [{ messageId: entry.id, message: entry.message }] : [],
          ),
      );
      expect(summarizeAgentActivity(history.flatMap((entry) => entry.items))).toEqual(
        summarizeAgentActivity(liveItems),
      );
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      stopEvents();
      blockReplyFlush.resolve();
      try {
        h.dispose();
      } finally {
        await resetCodeModeTestState();
      }
    }
  });

  it.each(["routine-only", "nested-routine", "visible-grandchild"])(
    "settles the %s activity graph without losing or double-counting its work",
    async (graph) => {
      const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>();
      const h = harness({ onAgentEvent });
      h.start("exec", "outer");
      if (graph !== "routine-only") {
        h.start("exec", "inner", {}, "outer");
      }
      h.start("progress_card", "routine", {}, graph === "routine-only" ? "outer" : "inner");
      if (graph === "visible-grandchild") {
        h.start("read", "read", { path: "release.md" }, "routine");
        h.end("read", "read", { content: [{ type: "text", text: "Release notes" }] });
      }
      h.end("progress_card", "routine", { content: [{ type: "text", text: "Updated" }] });
      if (graph !== "routine-only") {
        h.end("exec", "inner", { content: [] });
      }
      h.end("exec", "outer", { content: [] });
      await h.finish("Finished.");
      const items = onAgentEvent.mock.calls.flatMap(([event]) =>
        event.stream === "item" && Value.Check(AgentActivityItemSchema, event.data)
          ? [event.data]
          : [],
      );
      const visibleId =
        graph === "routine-only" ? "outer" : graph === "nested-routine" ? "inner" : "read";
      expect(summarizeAgentActivity(items).total).toBe(1);
      expect(
        items.findLast((item) => item.toolCallId === visibleId)?.hideFromChannelProgress,
      ).not.toBe(true);
      expect(items.findLast((item) => item.toolCallId === "routine")?.hideFromChannelProgress).toBe(
        true,
      );
      if (graph !== "routine-only") {
        expect(items.findLast((item) => item.toolCallId === "outer")?.hideFromChannelProgress).toBe(
          true,
        );
      }
    },
  );

  it.each(["execution-failed", "incomplete", "overlapping", "reused-active"])(
    "preserves the %s wrapper outcome",
    async (outcome) => {
      const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>();
      const h = harness({ onAgentEvent });
      h.start("exec", "outer");
      if (outcome === "overlapping") {
        h.start("exec", "outer");
      }
      h.start("read", "child", { path: "missing.txt" }, "outer");
      h.end("read", "child", { content: [{ type: "text", text: "Missing file" }] }, true);
      if (outcome !== "incomplete") {
        h.end("exec", "outer", {
          content: [{ type: "text", text: "Finished" }],
          ...(outcome === "execution-failed" ? { details: { status: "failed" } } : {}),
        });
      }
      if (outcome === "reused-active") {
        h.start("exec", "outer");
      }
      await h.subscription.waitForPendingEvents();
      const counters = h.subscription.getItemLifecycle();
      await h.finish("Observed the child outcome.");
      const events = onAgentEvent.mock.calls.map(([event]) => event);
      const outer = events.findLast(
        (event) => event.stream === "item" && event.data.toolCallId === "outer",
      );
      expect(outer?.data.hideFromChannelProgress === true).toBe(false);
      if (outcome === "execution-failed") {
        expect(outer?.data.status).toBe("failed");
      }
      expect(
        events.findLast((event) => event.stream === "item" && event.data.toolCallId === "child")
          ?.data,
      ).toMatchObject({ status: "failed" });
      expect(h.subscription.getItemLifecycle()).toEqual(counters);
    },
  );

  it("captures sanitized trajectory pairs while tool-start delivery remains blocked", async () => {
    const entered = createDeferred();
    const pending = createDeferred();
    const onBlockReplyFlush = vi.fn(() => {
      entered.resolve();
      return pending.promise;
    });
    const recordEvent = vi.fn<Recorder>();
    const h = harness({
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      onBlockReplyFlush,
    });
    const apiKey = "sk-1234567890abcdefXYZ";
    try {
      h.start("exec", "first-call", { command: "printf fixture", apiKey });
      expect(recordEvent).toHaveBeenCalledExactlyOnceWith("tool.call", {
        toolCallId: "first-call",
        name: "exec",
        args: { command: "printf fixture", apiKey: expect.any(String) },
      });
      expect(JSON.stringify(recordEvent.mock.calls)).not.toContain(apiKey);
      await entered.promise;
      h.end("exec", "first-call", {
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        details: { status: "completed", aggregated: "x".repeat(9_000) },
      });
      h.start("read", "second-call", { path: "/tmp/missing-trajectory-fixture" });
      h.end("read", "second-call", {
        details: { status: "error", error: "Fixture does not exist" },
      });
      expect(onBlockReplyFlush).toHaveBeenCalledOnce();
      expect(recordEvent.mock.calls).toEqual([
        ["tool.call", expect.objectContaining({ toolCallId: "first-call", name: "exec" })],
        [
          "tool.result",
          {
            toolCallId: "first-call",
            name: "exec",
            success: true,
            result: {
              content: [{ type: "image", mimeType: "image/png", bytes: 5, omitted: true }],
              details: {
                status: "completed",
                aggregated: `${"x".repeat(8_000)}\n...(live output truncated)...`,
              },
            },
          },
        ],
        [
          "tool.call",
          {
            toolCallId: "second-call",
            name: "read",
            args: { path: "/tmp/missing-trajectory-fixture" },
          },
        ],
        [
          "tool.result",
          {
            toolCallId: "second-call",
            name: "read",
            success: false,
            result: { details: { status: "error", error: "Fixture does not exist" } },
          },
        ],
      ]);
      pending.resolve();
      await h.subscription.waitForPendingEvents();
      expect(recordEvent).toHaveBeenCalledTimes(4);
    } finally {
      pending.resolve();
      await h.subscription.waitForPendingEvents();
    }
  });

  it("preserves nested failure and capture order when the recorder also throws", async () => {
    const order: string[] = [];
    const recordEvent = vi.fn<Recorder>((type) => {
      order.push(type);
      throw new Error("Trajectory storage failed");
    });
    const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>();
    const h = harness({
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      onAgentEvent,
    });
    const toolError = new Error("Nested fixture failed");
    const execution = h.subscription.runToolLifecycle({
      toolName: "read",
      toolCallId: "nested-call",
      args: { path: "/tmp/nested-trajectory-fixture", parentToolCallId: "argument-value" },
      execute: async (started) => {
        started();
        order.push("execute");
        h.emit({
          type: "tool_execution_update",
          toolName: "read",
          toolCallId: "nested-call",
          args: {},
          partialResult: { content: [{ type: "text", text: "Reading fixture" }] },
        });
        await h.subscription.waitForPendingEvents();
        throw toolError;
      },
    });
    await expect(execution).rejects.toBe(toolError);
    expect(order).toEqual(["tool.call", "execute", "tool.result"]);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "tool")
        .map(({ data }) => ({
          phase: data.phase,
          toolCallId: data.toolCallId,
          parentToolCallId: data.parentToolCallId,
        })),
    ).toEqual(
      ["start", "update", "result"].map((phase) => ({
        phase,
        toolCallId: "nested-call",
        parentToolCallId: undefined,
      })),
    );
    expect(recordEvent.mock.calls).toEqual([
      [
        "tool.call",
        {
          toolCallId: "nested-call",
          name: "read",
          args: { path: "/tmp/nested-trajectory-fixture", parentToolCallId: "argument-value" },
        },
      ],
      [
        "tool.result",
        expect.objectContaining({ toolCallId: "nested-call", name: "read", success: false }),
      ],
    ]);
  });

  it.each([
    { delivery: "resolve", flush: false },
    { delivery: "reject", flush: true },
  ] as const)(
    "preserves recovery behind an unavailable notice ($delivery, block flush: $flush)",
    async ({ delivery, flush }) => {
      const entered = createDeferred();
      const notice = createDeferred();
      const order: string[] = [];
      const answer = "I recovered the answer using another tool.";
      const onToolResult = vi.fn(async () => {
        order.push("notice entered");
        entered.resolve();
        try {
          await notice.promise;
        } finally {
          order.push("notice settled");
        }
      });
      const onPartialReply = vi.fn(() => {
        order.push("partial");
      });
      const onBlockReply = vi.fn(() => {
        order.push("block");
      });
      const onBlockReplyFlush = vi.fn(async () => {});
      const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>(({ stream, data }) => {
        if (stream === "lifecycle" && data.phase === "end") {
          order.push("terminal");
        }
      });
      const h = harness({
        onToolResult,
        onPartialReply,
        onBlockReply,
        onBlockReplyFlush: flush ? onBlockReplyFlush : undefined,
        onAssistantMessageStart: () => {
          order.push("assistant start");
        },
        onAgentEvent,
        blockReplyBreak: "message_end",
      });
      try {
        h.start("exec", "notice");
        h.end("exec", "notice", {
          details: { status: "approval-unavailable", reason: "no-approval-route" },
        });
        await entered.promise;
        expect(onToolResult).toHaveBeenCalledOnce();
        expect(onToolResult).toHaveBeenCalledWith(
          expect.objectContaining({
            channelData: { execApprovalUnavailable: { reason: "no-approval-route" } },
          }),
        );
        onBlockReplyFlush.mockClear();
        h.emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emitAssistantTextDeltaAndEnd({ emit: h.emit, text: answer });
        expect(h.subscription.getCurrentAttemptAssistant()).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: answer }],
        });
        h.emit({ type: "agent_end", messages: [], willRetry: false });
        const drain = h.subscription.waitForPendingEvents().then(() => {
          order.push("drained");
        });
        await setImmediate();
        expect([...order]).toEqual(["notice entered"]);
        expect(h.subscription.assistantTexts).toEqual([]);
        expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual(
          [],
        );
        expect(onBlockReplyFlush).not.toHaveBeenCalled();
        expect(h.subscription.didSendDeterministicApprovalPrompt()).toBe(false);
        if (delivery === "reject") {
          notice.reject(new Error("notice transport failed"));
        } else {
          notice.resolve();
        }
        await drain;
        expect(order).toEqual([
          "notice entered",
          "notice settled",
          "assistant start",
          "partial",
          "block",
          "terminal",
          "drained",
        ]);
        expect(onPartialReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: answer, delta: answer }),
        );
        expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: answer }),
          { assistantMessageIndex: 1 },
        );
        expect(onBlockReplyFlush.mock.calls).toEqual(
          flush ? [[{ reason: "message_end" }], [{ reason: "terminal" }]] : [],
        );
        expect(h.subscription.didSendDeterministicApprovalPrompt()).toBe(false);
        expect(h.subscription.getLastToolError()).toEqual(
          delivery === "reject"
            ? expect.objectContaining({
                error: "Approval prompt delivery failed: notice transport failed",
              })
            : undefined,
        );
        expect(
          buildEmbeddedRunPayloads({
            assistantTexts: h.subscription.assistantTexts,
            lastAssistant: h.subscription.getCurrentAttemptAssistant(),
            lastToolError: h.subscription.getLastToolError(),
            sessionKey: "agent:main:ordering",
            didSendDeterministicApprovalPrompt: h.subscription.didSendDeterministicApprovalPrompt(),
          }),
        ).toEqual([expect.objectContaining({ text: answer })]);
      } finally {
        notice.resolve();
        await h.subscription.waitForPendingEvents();
      }
    },
  );

  it("suppresses live and terminal-only assistant blocks after an approval prompt", async () => {
    const onToolResult = vi.fn();
    const onBlockReply = vi.fn();
    const onPartialReply = vi.fn();
    const onAgentEvent = vi.fn<NonNullable<Params["onAgentEvent"]>>();
    const h = harness({
      onToolResult,
      onBlockReply,
      onPartialReply,
      onAgentEvent,
      blockReplyBreak: "message_end",
    });
    const approvalId = "12345678-1234-1234-1234-123456789012";
    const first = createOpenAiResponsesPartial({
      text: "Approval is needed.",
      id: "approval-first",
      signaturePhase: "final_answer",
    });
    const final = {
      ...first,
      content: [
        ...first.content,
        createOpenAiResponsesTextBlock({
          text: "Please approve the command.",
          id: "approval-second",
          phase: "final_answer",
        }),
      ],
    };
    h.start("exec", "approval");
    h.end("exec", "approval", {
      details: {
        status: "approval-pending",
        approvalId,
        approvalSlug: "12345678",
        host: "gateway",
        command: "echo pending",
        expiresAtMs: Date.now() + 60_000,
      },
    });
    await h.subscription.waitForPendingEvents();
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channelData: expect.objectContaining({
          execApproval: expect.objectContaining({ approvalId }),
        }),
      }),
    );
    expect(h.subscription.didSendDeterministicApprovalPrompt()).toBe(true);
    h.emit({ type: "message_start", message: first });
    h.emit({
      type: "message_update",
      message: first,
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "Approval is needed.",
        partial: first,
      },
    });
    await h.subscription.waitForPendingEvents();
    expect(onBlockReply).not.toHaveBeenCalled();
    h.emit({ type: "message_end", message: final });
    h.emit({ type: "agent_end", messages: [final] });
    await h.subscription.waitForPendingEvents();
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual([]);
  });
});
