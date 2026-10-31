import { setImmediate as yieldImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import { CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE } from "./protocol.js";
import {
  createTerminalReleaseHarness,
  dynamicToolResult,
  rawCall,
  scope,
  terminalYieldResult,
} from "./run-attempt-lifecycle-controller.test-harness.js";

describe("Codex steering terminal delivery", () => {
  registerCodexEventProjectorTestLifecycle();

  it.each(["before", "after"] as const)(
    "projects the steered answer when consumption is %s final release checking",
    async (receipt) => {
      const telemetry = buildEmptyToolTelemetry();
      telemetry.didSendViaMessagingTool = true;
      telemetry.sourceReplyDelivered = true;
      telemetry.didDeliverSourceReplyViaMessageTool = true;
      telemetry.messagingToolSentTexts = ["ANSWER_A"];
      // Real native consumption follows the tool response, whose confirmed delivery
      // already updated this flag (codex turn.rs:551; dynamic-tools.ts:478).
      telemetry.finalSourceReplyDelivered = true;
      const onPartialReply = vi.fn();
      const projector = await createProjector(
        { ...(await createParams()), onPartialReply },
        { hasDeliveredFinalSourceReply: () => telemetry.finalSourceReplyDelivered === true },
      );
      await using h = createTerminalReleaseHarness({ projector, telemetry });
      const outcome = h.steeringQueue.queue("Second question", { debounceMs: 0 }).then(
        () => "consumed",
        () => "cancelled",
      );
      await yieldImmediate();
      const coda = {
        type: "agentMessage",
        id: "a-coda",
        phase: "final_answer",
        text: "REDUNDANT_A",
      };
      await h.notify({ method: "item/started", params: { ...scope, item: coda } });
      await h.notify({ method: "item/completed", params: { ...scope, item: coda } });
      const consume = () =>
        h.notify({
          method: "item/completed",
          params: {
            ...scope,
            item: {
              type: "userMessage",
              id: "input-b",
              clientId: "openclaw:turn-1:steer:1",
              content: [{ type: "text", text: "Second question" }],
            },
          },
        });
      if (receipt === "before") {
        await consume();
      }
      h.controller.recordDynamicToolResult(
        dynamicToolResult("first-answer", {
          success: true,
          terminate: true,
          finalSourceReplyDelivered: true,
        }),
      );
      await yieldImmediate();
      if (receipt === "after") {
        await consume();
      }
      await expect(outcome).resolves.toBe("consumed");
      const answer = {
        type: "agentMessage",
        id: "answer-b",
        phase: "final_answer",
        text: "ANSWER_A",
      };
      await h.notify({
        method: "item/started",
        params: { ...scope, item: { ...answer, text: "" } },
      });
      await h.notify({
        method: "item/agentMessage/delta",
        params: { ...scope, itemId: answer.id, delta: answer.text },
      });
      await h.notify({ method: "item/completed", params: { ...scope, item: answer } });
      await h.notify({
        method: "turn/completed",
        params: {
          threadId: scope.threadId,
          turn: { id: scope.turnId, status: "completed", items: [coda, answer] },
        },
      });
      const result = projector.buildResult(telemetry, {
        steeringMessages: h.steeringQueue.getAcceptedMessages(),
      });
      expect(onPartialReply).toHaveBeenCalledWith(expect.objectContaining({ text: "ANSWER_A" }));
      expect(result.assistantTexts).toEqual(["ANSWER_A"]);
      expect(JSON.stringify(result.messagesSnapshot)).not.toContain("REDUNDANT_A");
      expect(result.sourceReplyDelivered).toBe(true);
      expect(result.messagingToolSentTexts).toEqual(["ANSWER_A"]);
      expect(h.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    },
  );

  it.each([false, true])(
    "keeps authored siblings from ending a steered final batch (independent yield: %s)",
    async (withYield) => {
      await using h = createTerminalReleaseHarness();
      const consumed = h.steeringQueue.queue("Second question", { debounceMs: 0 });
      await yieldImmediate();
      await h.notifyRawItem(
        rawCall("first-answer", "message", CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE),
      );
      await h.notifyRawItem(
        rawCall("authored", "plugin_reply", CODEX_OPENCLAW_DIRECT_DYNAMIC_TOOL_NAMESPACE),
      );
      if (withYield) {
        await h.notifyRawCall("call-yield", "sessions_yield");
      }
      await h.finishResponse();
      const results = [
        dynamicToolResult("first-answer", {
          success: true,
          terminate: true,
          finalSourceReplyDelivered: true,
        }),
        dynamicToolResult("authored", {
          success: true,
          terminate: true,
          toolAuthoredSourceReply: {
            text: "AUTHORED_A",
            toolAuthored: true,
            sourceReplyFinal: true,
          },
        }),
        ...(withYield ? [terminalYieldResult(true)] : []),
      ];
      for (const result of results) {
        h.pendingOpenClawDynamicToolCompletionIds.add(result.call.callId);
      }
      for (const result of results) {
        h.controller.recordDynamicToolResult(result);
        h.pendingOpenClawDynamicToolCompletionIds.delete(result.call.callId);
      }
      expect(h.steeringQueue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
      await consumed;
      await yieldImmediate();
      expect(h.state.completed).toBe(withYield);
      expect(h.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(withYield);
      expect(h.sourceReplies.map((reply) => reply.text)).toEqual(withYield ? ["AUTHORED_A"] : []);
    },
  );

  it.each([
    ["reply-first", "direct"],
    ["yield-first", "direct"],
    ["reply-first", "nested"],
    ["yield-first", "nested"],
  ] as const)(
    "preserves an independent yield beside a steered final reply (%s, %s)",
    async (order, route) => {
      await using h = createTerminalReleaseHarness();
      const outcome = h.steeringQueue
        .queue("Second question", { debounceMs: 0 })
        .catch(() => undefined);
      await yieldImmediate();
      if (route === "direct") {
        await h.notifyRawCall("first-answer", "message");
        await h.notifyRawCall("call-yield", "sessions_yield");
      } else {
        await h.notifyRawItem({
          type: "function_call",
          call_id: "code-mode",
          name: "exec",
          namespace: "functions",
        });
      }
      await h.finishResponse();
      const reply = dynamicToolResult("first-answer", {
        success: true,
        terminate: true,
        finalSourceReplyDelivered: true,
      });
      const results =
        order === "reply-first"
          ? ([reply, terminalYieldResult(true)] as const)
          : ([terminalYieldResult(true), reply] as const);
      for (const result of results) {
        h.pendingOpenClawDynamicToolCompletionIds.add(result.call.callId);
      }
      h.controller.recordDynamicToolResult(results[0]);
      h.pendingOpenClawDynamicToolCompletionIds.delete(results[0].call.callId);
      expect(h.state.completed).toBe(false);
      h.controller.recordDynamicToolResult(results[1]);
      h.pendingOpenClawDynamicToolCompletionIds.delete(results[1].call.callId);
      h.controller.scheduleTerminalDynamicToolReleaseCheck();
      await yieldImmediate();
      // Upstream terminal release drains submitted input before interrupting.
      expect(h.state.completed).toBe(false);
      expect(h.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
      expect(h.steeringQueue.confirmConsumed("openclaw:turn-1:steer:1")).toBe(true);
      await outcome;
      await vi.waitFor(() => expect(h.state.completed).toBe(true));
      expect(h.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(true);
    },
  );
});
