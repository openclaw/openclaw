import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { hasSuccessfulSourceReplyDelivery } from "../auto-reply/reply/agent-runner-core.js";
import { hasCompletedSourceReplyDeliveryEvidence } from "./embedded-agent-runner/delivery-evidence.js";
import { buildSourceReplyPayloadState } from "./embedded-agent-runner/run/source-reply-payloads.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.start.js";
import {
  createTestContext,
  endTool,
} from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./sessions/agent-session-loop-resource-loader.test-support.js";
import type { MessageEndEvent } from "./sessions/extensions/types.js";
import { gatewayStub, validArgs } from "./tools/ask-user-tool.gateway.test-fixture.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";

// mock-isolation: Keep prompt-readiness RPCs on the fixture, never the operator Gateway.
vi.mock("./harness/gateway-question-dispatch.runtime.js", () => ({
  callGatewayTool: async (method: string) => {
    if (method !== "question.list") {
      throw new Error(`Unexpected question readiness RPC: ${method}`);
    }
    return { questions: [] };
  },
}));

registerAgentSessionLoopTestLifecycle();

const originalDetails = { sourceReply: { text: "Unreviewed reply." } };
const request = () =>
  ({ type: "toolCall", id: "reply-1", name: "order_status", arguments: {} }) as const;
const toolInfo = { name: "order_status", label: "Order status", description: "Read order status" };
const response = (...args: Parameters<typeof createAssistant>) =>
  createAssistantResultStream(createAssistant(...args));
const makeToolResult = (details: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: "Status read." }],
  details,
});

it.each([
  ["rewrites", originalDetails, { sourceReply: { text: "Safe reply." } }, ["Safe reply."]],
  ["withdraws", originalDetails, { redacted: true }, []],
  ["adds", { ok: true }, { sourceReply: { text: "Added reply." } }, ["Added reply."]],
] as const)(
  "%s the source reply through a real message_end extension",
  async (_label, initial, final, expected) => {
    streamMocks.streamSimple
      .mockImplementationOnce((model) => response(model, [request()], "toolUse"))
      .mockImplementation((model) => response(model, "Model continued."));
    const parameters = Type.Object({});
    const { session } = await createTestSession({
      customTools: [{ ...toolInfo, parameters, execute: async () => makeToolResult(initial) }],
      resourceLoader: await createResourceLoader((api) => {
        api.on("message_end", async (event: unknown) => {
          const { message } = event as MessageEndEvent;
          return message.role === "toolResult"
            ? { message: { ...message, details: final } }
            : undefined;
        });
      }),
    });
    const sub = subscribeEmbeddedAgentSession({
      session,
      runId: "run-finalized",
      sourceReplyCapableToolNames: new Set(["order_status"]),
    });
    try {
      await session.prompt("Check the order.");
      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(expected.length ? 1 : 2);
      expect(sub.getMessagingToolSourceReplyPayloads().map((reply) => reply.text)).toEqual(
        expected,
      );
      expect(sub.getSourceReplyDelivered()).toBeUndefined();
      const toolResult = session.messages.findLast((entry) => entry.role === "toolResult");
      expect(toolResult).toMatchObject({ details: final });
    } finally {
      sub.unsubscribe();
    }
  },
);

it("does not deliver a capable tool's nested Code Mode result", async () => {
  const { ctx } = createTestContext();
  ctx.params.sourceReplyCapableToolNames = new Set(["order_status"]);
  const tool = { toolName: "order_status", toolCallId: "nested-1" };
  await handleToolExecutionStart(ctx, {
    type: "tool_execution_start",
    ...tool,
    args: {},
    lifecycleProvenance: "nested",
    parentToolCallId: "exec-1",
  });
  await endTool(ctx, {
    ...tool,
    result: makeToolResult(originalDetails),
  });
  expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
});

describe("native question prompt source progress", () => {
  it.each(["delivered", "failed", "answered", "suppressed"] as const)(
    "retains only successful prompt delivery before durable handoff: %s",
    async (outcome) => {
      const { ctx } = createTestContext();
      const toolCallId = `question-progress-${outcome}`;
      const delivered = createDeferred();
      const published = createDeferred();
      const onToolResult = vi.fn(async () => {
        published.resolve();
        await delivered.promise;
        if (outcome === "failed") {
          throw new Error("prompt transport failed");
        }
        return outcome !== "suppressed";
      });
      ctx.params.onToolResult = onToolResult;
      const gateway = gatewayStub(async (method, _options, params) => {
        if (method === "question.request") {
          return {
            id: params.id,
            durable: true,
            ...(outcome === "answered" ? { status: "answered" } : {}),
          };
        }
        if (method === "question.resolve") {
          return { status: "cancelled" };
        }
        throw new Error(`Unexpected live answer waiter: ${method}`);
      });
      const handoff = vi.fn();
      const tool = createAskUserTool({
        sessionKey: ctx.params.sessionKey,
        runId: ctx.params.runId,
        agentId: ctx.params.agentId,
        gatewayCall: gateway.call,
        nativeQuestionHandoff: handoff,
      });
      await handleToolExecutionStart(ctx, {
        type: "tool_execution_start",
        toolName: "ask_user",
        toolCallId,
        args: validArgs,
      });
      const execution = tool.execute(toolCallId, validArgs).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        if (outcome !== "answered") {
          await published.promise;
          expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
          expect(handoff).not.toHaveBeenCalled();
        }
        delivered.resolve();
        const result = await execution;
        expect(handoff).toHaveBeenCalledOnce();
        if (outcome === "failed" || outcome === "suppressed") {
          expect(result).toMatchObject({
            error: expect.objectContaining({ message: "ask_user prompt delivery failed" }),
          });
        } else {
          expect(result).toMatchObject({ result: { details: { status: "waiting" } } });
        }
        expect(
          hasSuccessfulSourceReplyDelivery({
            blockReplyPipeline: null,
            messagingToolSentTexts: ctx.state.messagingToolSentTexts,
            messagingToolSentMediaUrls: ctx.state.messagingToolSentMediaUrls,
            messagingToolSentTargets: ctx.state.messagingToolSentTargets,
          }),
        ).toBe(outcome === "delivered");
        expect(
          buildSourceReplyPayloadState({
            payloads: ctx.state.messagingToolSourceReplyPayloads,
            sessionKey: ctx.params.sessionKey ?? "",
          }).replyItems,
        ).toEqual([]);
        expect(hasCompletedSourceReplyDeliveryEvidence(ctx.state)).toBe(false);
        if (outcome === "delivered") {
          expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([{ sourceReplyFinal: false }]);
          expect(ctx.state.messagingToolSentTexts).toEqual([
            expect.stringContaining("Question for you:"),
          ]);
          expect(ctx.state.messagingToolSentTextsNormalized).toHaveLength(1);
        } else {
          expect(ctx.state.messagingToolSourceReplyPayloads).toEqual([]);
          expect(ctx.state.messagingToolSentTexts).toEqual([]);
          expect(ctx.state.messagingToolSentTextsNormalized).toEqual([]);
        }
        if (outcome === "answered") {
          expect(onToolResult).not.toHaveBeenCalled();
        }
      } finally {
        delivered.resolve();
        await execution;
      }
    },
  );
  it("does not retain a late prompt callback after the asking run aborts and unsubscribes", async () => {
    const published = createDeferred();
    const delivered = createDeferred();
    const signal = new AbortController();
    const handoff = vi.fn();
    const h = createSubscribedSessionHarness({
      runId: "aborted-question",
      sessionKey: "agent:unit-session",
      onToolResult: async () => {
        published.resolve();
        await delivered.promise;
      },
    });
    const gateway = gatewayStub(async (method, _options, params) => {
      if (method === "question.request") {
        return { id: params.id, durable: true };
      }
      throw new Error(`Unexpected aborted question operation: ${method}`);
    });
    const tool = createAskUserTool({
      sessionKey: "agent:unit-session",
      runId: "aborted-question",
      gatewayCall: gateway.call,
      nativeQuestionHandoff: handoff,
    });
    h.emit({
      type: "tool_execution_start",
      toolName: "ask_user",
      toolCallId: "aborted-prompt",
      args: validArgs,
    });
    const execution = tool
      .execute("aborted-prompt", validArgs, signal.signal)
      .catch((error: unknown) => error);
    try {
      await published.promise;
      signal.abort();
      h.subscription.unsubscribe();
      delivered.resolve();
      await execution;
      await h.subscription.waitForPendingEvents();
      expect(handoff).not.toHaveBeenCalled();
      expect(h.subscription.getMessagingToolSourceReplyPayloads()).toEqual([]);
      expect(h.subscription.getMessagingToolSentTexts()).toEqual([]);
    } finally {
      delivered.resolve();
      await execution;
      h.subscription.unsubscribe();
    }
  });
});
