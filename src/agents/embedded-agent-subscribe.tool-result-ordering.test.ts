import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
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

describe("subscribeEmbeddedAgentSession tool result ordering", () => {
  it("settles subscribed nested dispatch exactly once across repeated exec and wait turns", async () => {
    const blockReplyFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => blockReplyFlush.promise);
    const harness = createSubscribedCodeModeHarness({
      name: "repeated-lifecycle",
      onBlockReplyFlush,
    });
    const target = pluginToolWithExecute("finish_stage", "Finish one suspended stage", async () => {
      blockReplyFlush.resolve();
      return jsonResult({ finished: true });
    });
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });
    const liveItems: AgentActivityItem[] = [];
    const stopEvents = subscribeToAgentEvents((event) => {
      if (
        event.runId === harness.runId &&
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
        harness.sessionManager.appendMessage(
          makeAgentAssistantMessage({
            content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: args }],
            stopReason: "toolUse",
          }),
        );
        const result = await harness.subscription.runToolLifecycle({
          toolName: "exec",
          toolCallId,
          args,
          execute: async (started) => {
            started();
            return expectDefined(harness.tools[0], "Code Mode exec test invariant").execute(
              toolCallId,
              args,
            );
          },
        });
        harness.sessionManager.appendMessage({
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
          waitTool: expectDefined(harness.tools[1], "Code Mode wait test invariant"),
        });
        expect(completed).toMatchObject({ status: "completed", value: { finished: true } });
        expect(countActiveToolExecutions(harness.runId)).toBe(0);
      }

      expect(target.execute).toHaveBeenCalledTimes(2);
      expect(onBlockReplyFlush).not.toHaveBeenCalled();
      expect(harness.subscription.getItemLifecycle()).toMatchObject({
        startedCount: 4,
        completedCount: 4,
        activeCount: 0,
      });
      expect(summarizeAgentActivity(liveItems).total).toBe(4);
      emitAssistantTextDeltaAndEnd({ emit: harness.emit, text: "Both stages finished." });
      harness.emit({ type: "agent_end", messages: [], willRetry: false });
      await harness.subscription.waitForPendingEvents();
      expect(summarizeAgentActivity(liveItems).total).toBe(2);
      expect(harness.subscription.getItemLifecycle()).toEqual({
        startedCount: 4,
        completedCount: 4,
        activeCount: 0,
      });
      const history = projectAgentHistoryActivity(
        harness.sessionManager
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
        harness.dispose();
      } finally {
        await resetCodeModeTestState();
      }
    }
  });

  it.each([
    "completed",
    "failed",
    "execution-failed",
    "blocked",
    "incomplete",
    "overlapping",
    "reused-active",
  ])("settles the prepared summary without hiding a %s wrapper outcome", async (outcome) => {
    const onAgentEvent = vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onAgentEvent"]>>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: `wrapper-${outcome}`,
      onAgentEvent,
    });
    const start = {
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "outer",
      args: {},
    };
    try {
      emit(start);
      if (outcome === "overlapping") {
        emit(start);
      }
      emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "child",
        parentToolCallId: "outer",
        args: { path: "missing.txt" },
      });
      emit({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "child",
        isError: true,
        result: { content: [{ type: "text", text: "Missing file" }] },
      });
      if (outcome !== "incomplete") {
        emit({
          type: "tool_execution_end",
          toolName: "exec",
          toolCallId: "outer",
          isError: outcome === "failed",
          result: {
            content: [{ type: "text", text: "Finished" }],
            ...(outcome === "blocked" ? { details: { status: "approval-pending" } } : {}),
            ...(outcome === "execution-failed" ? { details: { status: "failed" } } : {}),
          },
        });
      }
      if (outcome === "reused-active") {
        emit(start);
      }
      await subscription.waitForPendingEvents();
      const counters = subscription.getItemLifecycle();
      emitAssistantTextDeltaAndEnd({ emit, text: "Observed the child outcome." });
      emit({ type: "agent_end", messages: [], willRetry: false });
      await subscription.waitForPendingEvents();
      const events = onAgentEvent.mock.calls.map(([event]) => event);
      const outer = events.findLast(
        (event) => event.stream === "item" && event.data.toolCallId === "outer",
      );
      expect(outer?.data.hideFromChannelProgress === true).toBe(outcome === "completed");
      if (outcome === "execution-failed") {
        expect(outer?.data.status).toBe("failed");
      }
      expect(
        events.findLast((event) => event.stream === "item" && event.data.toolCallId === "child")
          ?.data,
      ).toMatchObject({ status: "failed" });
      expect(subscription.getItemLifecycle()).toEqual(counters);
    } finally {
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
    }
  });

  it("captures sanitized trajectory pairs while tool-start delivery remains blocked", async () => {
    const flushEntered = createDeferred();
    const pendingFlush = createDeferred();
    const onBlockReplyFlush = vi.fn(() => {
      flushEntered.resolve();
      return pendingFlush.promise;
    });
    const recordEvent =
      vi.fn<
        NonNullable<SubscribeEmbeddedAgentSessionParams["trajectoryRecorder"]>["recordEvent"]
      >();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-trajectory-pending-delivery",
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      onBlockReplyFlush,
    });
    const apiKey = "sk-1234567890abcdefXYZ";

    try {
      emit({
        type: "tool_execution_start",
        toolName: "exec",
        toolCallId: "first-call",
        args: { command: "printf fixture", apiKey },
      });
      expect(recordEvent).toHaveBeenCalledExactlyOnceWith("tool.call", {
        toolCallId: "first-call",
        name: "exec",
        args: { command: "printf fixture", apiKey: expect.any(String) },
      });
      expect(JSON.stringify(recordEvent.mock.calls)).not.toContain(apiKey);
      await flushEntered.promise;

      emit({
        type: "tool_execution_end",
        toolName: "exec",
        toolCallId: "first-call",
        isError: false,
        result: {
          content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
          details: { status: "completed", aggregated: "x".repeat(9_000) },
        },
      });
      emit({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "second-call",
        args: { path: "/tmp/missing-trajectory-fixture" },
      });
      emit({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "second-call",
        isError: false,
        result: { details: { status: "error", error: "Fixture does not exist" } },
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

      pendingFlush.resolve();
      await subscription.waitForPendingEvents();
      expect(recordEvent).toHaveBeenCalledTimes(4);
    } finally {
      pendingFlush.resolve();
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
    }
  });

  it("settles tool delivery when trajectory recording throws", async () => {
    const recordEvent = vi.fn(() => {
      throw new Error("Trajectory storage failed");
    });
    const onAgentToolResult = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-trajectory-recording-failure",
      trajectoryRecorder: { recordEvent, flush: async () => {} },
      onAgentToolResult,
    });
    const result = { content: [{ type: "text", text: "Fixture contents" }] };

    try {
      expect(() =>
        emit({
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "recording-failure-call",
          args: { path: "/tmp/trajectory-fixture" },
        }),
      ).not.toThrow();
      expect(() =>
        emit({
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "recording-failure-call",
          isError: false,
          result,
        }),
      ).not.toThrow();
      emitAssistantTextDeltaAndEnd({ emit, text: "The tool completed." });
      emit({ type: "agent_end", messages: [], willRetry: false });
      await subscription.waitForPendingEvents();

      expect(recordEvent).toHaveBeenCalledTimes(2);
      expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
        toolName: "read",
        result,
        isError: false,
      });
      expect(subscription.getLastToolError()).toBeUndefined();
      expect(subscription.assistantTexts).toEqual(["The tool completed."]);
    } finally {
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
    }
  });

  it.each([
    { outcome: "success", success: true, recorderFails: false, parentToolCallId: "outer-call" },
    { outcome: "failure", success: false, recorderFails: false, parentToolCallId: "outer-call" },
    { outcome: "success", success: true, recorderFails: true, parentToolCallId: undefined },
    { outcome: "failure", success: false, recorderFails: true, parentToolCallId: undefined },
  ])(
    "preserves nested tool outcomes and capture order ($outcome, recorder fails: $recorderFails)",
    async ({ success, recorderFails, parentToolCallId }) => {
      const order: string[] = [];
      const recordEvent = vi.fn<
        NonNullable<SubscribeEmbeddedAgentSessionParams["trajectoryRecorder"]>["recordEvent"]
      >((type) => {
        order.push(type);
        if (recorderFails) {
          throw new Error("Trajectory storage failed");
        }
      });
      const onAgentEvent =
        vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onAgentEvent"]>>();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-nested-trajectory-${success}-${recorderFails}`,
        trajectoryRecorder: { recordEvent, flush: async () => {} },
        onAgentEvent,
      });
      const result = { content: [{ type: "text", text: "Nested fixture" }] };
      const toolError = new Error("Nested fixture failed");

      try {
        const execution = subscription.runToolLifecycle({
          toolName: "read",
          toolCallId: "nested-call",
          parentToolCallId,
          args: {
            path: "/tmp/nested-trajectory-fixture",
            parentToolCallId: "argument-value",
          },
          execute: async (onImplementationStart) => {
            onImplementationStart();
            order.push("execute");
            emit({
              type: "tool_execution_update",
              toolName: "read",
              toolCallId: "nested-call",
              args: {},
              partialResult: { content: [{ type: "text", text: "Reading fixture" }] },
            });
            await subscription.waitForPendingEvents();
            if (!success) {
              throw toolError;
            }
            return result;
          },
        });
        if (success) {
          await expect(execution).resolves.toBe(result);
        } else {
          await expect(execution).rejects.toBe(toolError);
        }
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
            parentToolCallId,
          })),
        );
        expect(recordEvent.mock.calls).toEqual([
          [
            "tool.call",
            {
              toolCallId: "nested-call",
              name: "read",
              args: {
                path: "/tmp/nested-trajectory-fixture",
                parentToolCallId: "argument-value",
              },
            },
          ],
          [
            "tool.result",
            expect.objectContaining({ toolCallId: "nested-call", name: "read", success }),
          ],
        ]);
      } finally {
        await subscription.waitForPendingEvents();
        subscription.unsubscribe();
      }
    },
  );

  it.each([
    { delivery: "resolve", flush: false },
    { delivery: "reject", flush: false },
    { delivery: "resolve", flush: true },
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
      const onAgentEvent = vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onAgentEvent"]>>(
        ({ stream, data }) => {
          if (stream === "lifecycle" && data.phase === "end") {
            order.push("terminal");
          }
        },
      );
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-unavailable-${delivery}-${flush}`,
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
        emit({ type: "tool_execution_start", toolName: "exec", toolCallId: "notice", args: {} });
        emit({
          type: "tool_execution_end",
          toolName: "exec",
          toolCallId: "notice",
          isError: false,
          result: {
            details: { status: "approval-unavailable", reason: "no-approval-route" },
          },
        });
        await entered.promise;
        expect(onToolResult).toHaveBeenCalledOnce();
        expect(onToolResult).toHaveBeenCalledWith(
          expect.objectContaining({
            channelData: { execApprovalUnavailable: { reason: "no-approval-route" } },
          }),
        );
        onBlockReplyFlush.mockClear();

        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emitAssistantTextDeltaAndEnd({ emit, text: answer });
        // Model facts are captured at ingress while visible delivery waits for the notice.
        expect(subscription.getCurrentAttemptAssistant()).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: answer }],
        });
        emit({ type: "agent_end", messages: [], willRetry: false });
        const drain = subscription.waitForPendingEvents().then(() => {
          order.push("drained");
        });

        // Let already-runnable handlers finish; the notice remains explicitly unresolved.
        await setImmediate();
        expect([...order]).toEqual(["notice entered"]);
        expect(subscription.assistantTexts).toEqual([]);
        expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual(
          [],
        );
        expect(onBlockReplyFlush).not.toHaveBeenCalled();
        expect(subscription.didSendDeterministicApprovalPrompt()).toBe(false);

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
        expect(subscription.didSendDeterministicApprovalPrompt()).toBe(false);
        expect(subscription.getLastToolError()).toEqual(
          delivery === "reject"
            ? expect.objectContaining({
                error: "Approval prompt delivery failed: notice transport failed",
              })
            : undefined,
        );
        expect(
          buildEmbeddedRunPayloads({
            assistantTexts: subscription.assistantTexts,
            lastAssistant: subscription.getCurrentAttemptAssistant(),
            lastToolError: subscription.getLastToolError(),
            sessionKey: "agent:main:ordering",
            didSendDeterministicApprovalPrompt: subscription.didSendDeterministicApprovalPrompt(),
          }),
        ).toEqual([expect.objectContaining({ text: answer })]);
      } finally {
        notice.resolve();
        await subscription.waitForPendingEvents();
        subscription.unsubscribe();
      }
    },
  );

  it.each(["live", "terminal-only"] as const)(
    "suppresses assistant blocks after an approval prompt (%s boundary)",
    async (boundary) => {
      const onToolResult = vi.fn();
      const onBlockReply = vi.fn();
      const onPartialReply = vi.fn();
      const onAgentEvent =
        vi.fn<NonNullable<SubscribeEmbeddedAgentSessionParams["onAgentEvent"]>>();
      const { emit, subscription } = createSubscribedSessionHarness({
        runId: `run-approval-${boundary}`,
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

      try {
        emit({ type: "tool_execution_start", toolName: "exec", toolCallId: "approval", args: {} });
        emit({
          type: "tool_execution_end",
          toolName: "exec",
          toolCallId: "approval",
          isError: false,
          result: {
            details: {
              status: "approval-pending",
              approvalId,
              approvalSlug: "12345678",
              host: "gateway",
              command: "echo pending",
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });
        await subscription.waitForPendingEvents();
        expect(onToolResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            channelData: expect.objectContaining({
              execApproval: expect.objectContaining({ approvalId }),
            }),
          }),
        );
        expect(subscription.didSendDeterministicApprovalPrompt()).toBe(true);

        emit({ type: "message_start", message: first });
        for (const [contentIndex, block] of final.content.entries()) {
          if (contentIndex > 0 && boundary === "terminal-only") {
            break;
          }
          const partial = { ...final, content: final.content.slice(0, contentIndex + 1) };
          emit({
            type: "message_update",
            message: partial,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex,
              delta: block.text,
              partial,
            },
          });
        }
        await subscription.waitForPendingEvents();
        expect(onBlockReply).not.toHaveBeenCalled();

        emit({ type: "message_end", message: final });
        emit({ type: "agent_end", messages: [final] });
        await subscription.waitForPendingEvents();
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(onPartialReply).not.toHaveBeenCalled();
        expect(onAgentEvent.mock.calls.filter(([event]) => event.stream === "assistant")).toEqual(
          [],
        );
      } finally {
        await subscription.waitForPendingEvents();
        subscription.unsubscribe();
      }
    },
  );
});
