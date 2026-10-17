import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { createStubSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { Agent } from "../../runtime/index.js";
import { createMessageTool } from "../../tools/message-tool-execution.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import { installMessageToolTerminalHook } from "./message-tool-terminal.js";
import {
  terminalModel as model,
  terminalResponse,
  terminalToolCall,
} from "./message-tool-terminal.test-support.js";
import { buildPayloads } from "./payloads.test-helpers.js";

const answer = "Answer for input A.";

describe("confirmed message-tool turn completion", () => {
  it.each([false, true])(
    "surfaces a steered input failure after the preceding source reply (final=%s)",
    async (final) => {
      const config = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const { session, emit } = createStubSessionHarness();
      let requests = 0;
      let delivered = false;
      const sourceTool = createMessageTool({
        config,
        preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
        currentChannelProvider: "webchat",
        sourceReplyDeliveryMode: "automatic",
        agentSessionKey: "agent:main:webchat:dm:steered-source-reply",
        runId: "steered-source-reply",
        getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
        resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
          resolvedConfig,
          diagnostics: [],
          targetStatesByPath: {},
          hadUnresolvedTargets: false,
        }),
      });
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            {
              name: "message",
              label: "Message",
              description: "Reply to source",
              parameters: Type.Object({
                action: Type.String(),
                message: Type.String(),
                final: Type.Boolean(),
              }),
              execute: async (id, args) => {
                const result = await sourceTool.execute(id, args);
                expect(result.details).toMatchObject({
                  messageDelivery: { status: "settled" },
                });
                agent.steer({
                  role: "user",
                  content: "Input B: answer my next question.",
                  timestamp: 1,
                });
                return result;
              },
            },
          ],
        },
        streamFn: () => {
          requests += 1;
          return terminalResponse(
            requests === 1
              ? [
                  terminalToolCall("message", "source-a", {
                    action: "send",
                    message: answer,
                    final,
                  }),
                ]
              : [],
            requests === 1 ? "toolUse" : "error",
            {
              timestamp: requests,
              ...(requests === 1
                ? {}
                : { errorMessage: "Provider failed answering steered input B" }),
            },
          );
        },
      });
      Object.assign(session, { agent });
      agent.afterToolCall = async (context) => {
        recordEmbeddedToolReceipt(
          session.sessionManager,
          context.toolCall.id,
          context.result.details,
          true,
        );
        return undefined;
      };
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode: "automatic",
        onDeliveredSourceReply: () => {
          delivered = true;
        },
      });
      const subscription = subscribeEmbeddedAgentSession({
        session,
        runId: "steered-source-reply",
        sourceReplyDeliveryMode: "automatic",
        messageChannel: "webchat",
      });
      const unsubscribe = agent.subscribe(emit);
      try {
        await agent.prompt("Input A: reply through the message tool.");
        await subscription.waitForPendingEvents();
        const sourceReplyDeliveryState = subscription.getSourceReplyDeliveryState();
        expect([requests, delivered, sourceReplyDeliveryState]).toEqual([2, final, "missing"]);
        expect(subscription.answerSegments).toEqual([
          expect.objectContaining({ sourceReplyDeliveryState: final ? "delivered" : "missing" }),
        ]);
        const replies = subscription.getMessagingToolSourceReplyPayloads();
        expect(replies).toEqual([
          expect.objectContaining({
            text: answer,
            ...(final ? { sourceReplyFinal: true } : {}),
          }),
        ]);
        const lastAssistant = agent.state.messages.findLast(
          (message): message is AssistantMessage => message.role === "assistant",
        );
        expect(lastAssistant?.stopReason).toBe("error");
        const payloads = buildPayloads({
          sourceReplyDeliveryMode: "automatic",
          sourceReplyDeliveryState,
          assistantTexts: subscription.assistantTexts,
          answerSegments: subscription.answerSegments,
          messagingToolSentTargets: subscription.getMessagingToolSentTargets(),
          messagingToolSourceReplyPayloads: replies,
          didDeliverSourceReplyViaMessageTool:
            resolveSourceReplyDelivery({ sourceReplyDeliveryState }) === "delivered",
          lastAssistant,
        });
        expect(payloads).toContainEqual(expect.objectContaining({ text: answer }));
        expect(payloads.some((payload) => payload.isError === true)).toBe(true);
      } finally {
        unsubscribe();
        subscription.unsubscribe();
        clearRuntimeConfigSnapshot();
      }
    },
  );
  it.each([
    { final: true, hookThrows: false },
    { final: false, hookThrows: false },
    { final: true, hookThrows: true },
  ])(
    "settles sibling tools and only continues progress (final=$final, hookThrows=$hookThrows)",
    async ({ final, hookThrows }) => {
      let requests = 0;
      let deliveries = 0;
      const executed: string[] = [];
      const agent = new Agent({
        initialState: {
          model,
          tools: [
            {
              name: "message",
              label: "Message",
              description: "Reply to the current source",
              parameters: Type.Object({ action: Type.String(), final: Type.Boolean() }),
              execute: async () => {
                executed.push("message");
                return {
                  content: [],
                  details: {
                    messageDelivery: {
                      status: "settled",
                      partialDelivery: false,
                      createdThreadIds: [],
                      ...(final ? { sourceReplyDelivered: true } : {}),
                    },
                    sourceReplyRoute: "current-source",
                  },
                };
              },
            },
            {
              name: "lookup",
              label: "Lookup",
              description: "Read a value",
              parameters: Type.Object({}),
              execute: async () => {
                executed.push("lookup");
                return { content: [], details: { value: 42 } };
              },
            },
          ],
        },
        streamFn: () => {
          requests += 1;
          const content: AssistantMessage["content"] =
            requests === 1
              ? [
                  terminalToolCall("message", "source-reply", { action: "send", final }),
                  terminalToolCall("lookup", "lookup"),
                ]
              : [{ type: "text", text: "Another visible answer." }];
          return terminalResponse(content, requests === 1 ? "toolUse" : "stop");
        },
      });
      agent.afterToolCall = async (context) => {
        if (hookThrows && context.toolCall.name === "message") {
          context.result.details = { redacted: true };
          context.args = { action: "send", final: false };
          throw new Error("Presentation hook failed");
        }
        return undefined;
      };
      installMessageToolTerminalHook({
        agent,
        sourceReplyDeliveryMode: "automatic",
        onDeliveredSourceReply: () => {
          deliveries += 1;
        },
      });

      await agent.prompt("Answer with a source reply.");

      expect({ executed, deliveries, requests }).toEqual({
        executed: ["message", "lookup"],
        deliveries: 1,
        requests: final ? 1 : 2,
      });
      expect(
        agent.state.messages.some(
          (message) =>
            message.role === "assistant" && message.content.some((block) => block.type === "text"),
        ),
      ).toBe(!final);
      expect(
        agent.state.messages.some((message) => message.role === "toolResult" && message.isError),
      ).toBe(hookThrows);
    },
  );
});
