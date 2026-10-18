import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { createStubSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { createMessageTool } from "../../tools/message-tool-execution.js";
import { resolveSourceReplyDelivery } from "../delivery-evidence.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import {
  terminalMessageAgent,
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
      const run = terminalMessageAgent(
        [
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
        (requests) =>
          terminalResponse(
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
          ),
        async (context) => {
          recordEmbeddedToolReceipt(
            session.sessionManager,
            context.toolCall.id,
            context.result.details,
            true,
          );
        },
      );
      const { agent, counts } = run;
      Object.assign(session, { agent });
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
        const { requests, deliveries } = counts;
        expect([requests, deliveries > 0, sourceReplyDeliveryState]).toEqual([2, final, "missing"]);
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
  it("delivers a message-tool-only answer that waits behind a running sequential call", async () => {
    const config = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(config);
    const sourceTool = createMessageTool({
      config,
      preparedMessageToolCatalog: { version: 0, channels: [], getChannel: () => undefined },
      currentChannelProvider: "webchat",
      sourceReplyDeliveryMode: "message_tool_only",
      agentSessionKey: "agent:main:webchat:dm:steered-tail-reply",
      runId: "steered-tail-reply",
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config: resolvedConfig }) => ({
        resolvedConfig,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
    });
    const steer = { role: "user" as const, content: "Input B: one more question.", timestamp: 1 };
    const sent: unknown[] = [];
    const { agent, counts } = terminalMessageAgent(
      [
        {
          name: "lookup",
          label: "Lookup",
          description: "Read a value",
          parameters: Type.Object({}),
          executionMode: "sequential",
          execute: async () => {
            // Input B arrives while this call runs, before the answer's send launches.
            agent.steer(steer);
            return { content: [{ type: "text", text: "42" }], details: {} };
          },
        },
        {
          name: "message",
          label: "Message",
          description: "Reply to the current source",
          parameters: Type.Object({ action: Type.String(), message: Type.String() }),
          execute: async (id, args) => {
            const result = await sourceTool.execute(id, args);
            sent.push(args);
            return result;
          },
        },
      ],
      (requests) =>
        terminalResponse(
          [
            ...(requests === 1 ? [terminalToolCall("lookup", "lookup")] : []),
            terminalToolCall("message", `source-${requests}`, {
              action: "send",
              message: requests === 1 ? answer : "Answer for input B.",
            }),
          ],
          "toolUse",
          { timestamp: requests },
        ),
      undefined,
      "message_tool_only",
    );

    try {
      await agent.prompt("Input A: look it up and answer.");
    } finally {
      clearRuntimeConfigSnapshot();
    }

    expect({ sent, ...counts }).toEqual({
      sent: [
        { action: "send", message: answer },
        { action: "send", message: "Answer for input B." },
      ],
      requests: 2,
      deliveries: 2,
    });
    const steerIndex = agent.state.messages.indexOf(steer);
    expect(agent.state.messages.slice(steerIndex - 2, steerIndex + 1)).toMatchObject([
      { role: "toolResult", toolCallId: "lookup", isError: false },
      { role: "toolResult", toolCallId: "source-1", isError: false },
      steer,
    ]);
  });
  it.each([
    { final: true, hookThrows: false },
    { final: false, hookThrows: false },
    { final: true, hookThrows: true },
  ])(
    "settles sibling tools and only continues progress (final=$final, hookThrows=$hookThrows)",
    async ({ final, hookThrows }) => {
      const executed: string[] = [];
      const run = terminalMessageAgent(
        [
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
        (requests) => {
          const content: AssistantMessage["content"] =
            requests === 1
              ? [
                  terminalToolCall("message", "source-reply", { action: "send", final }),
                  terminalToolCall("lookup", "lookup"),
                ]
              : [{ type: "text", text: "Another visible answer." }];
          return terminalResponse(content, requests === 1 ? "toolUse" : "stop");
        },
        async (context) => {
          if (hookThrows && context.toolCall.name === "message") {
            context.result.details = { redacted: true };
            context.args = { action: "send", final: false };
            throw new Error("Presentation hook failed");
          }
        },
      );
      const { agent, counts } = run;

      await agent.prompt("Answer with a source reply.");

      expect({ executed, ...counts }).toEqual({
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
