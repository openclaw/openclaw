// Gateway Protocol tests cover agent behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentParamsSchema,
  ConversationListParamsSchema,
  ConversationListResultSchema,
  ConversationSendParamsSchema,
  ConversationSendResultSchema,
  ConversationTurnCancelParamsSchema,
  ConversationTurnCancelResultSchema,
  ConversationTurnParamsSchema,
  ConversationTurnResultSchema,
  MessageActionParamsSchema,
} from "./agent.js";

describe("AgentParamsSchema", () => {
  it("accepts bounded model-run generation settings", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "classify",
        modelRun: true,
        modelRunRequestedOverrides: { maxTokens: 64, temperature: 0 },
        idempotencyKey: "model-run-1",
      }),
    ).toBe(true);
  });

  it.each([
    { maxTokens: 0, temperature: 0 },
    { maxTokens: 64.5, temperature: 0 },
    { maxTokens: 64, temperature: -0.1 },
    { maxTokens: 64, temperature: 2.1 },
    { maxTokens: 64, temperature: 0, unexpected: true },
  ])("rejects invalid model-run generation settings %#", (modelRunRequestedOverrides) => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "classify",
        modelRun: true,
        modelRunRequestedOverrides,
        idempotencyKey: "model-run-1",
      }),
    ).toBe(false);
  });

  it.each([undefined])(
    "accepts the backend expected-session binding with revision %s",
    (revision) => {
      expect(
        Value.Check(AgentParamsSchema, {
          message: "resume",
          sessionKey: "agent:main:main",
          expectedExistingSessionId: "session-1",
          expectedExistingSessionLifecycleRevision: revision,
          idempotencyKey: "recovery-1",
        }),
      ).toBe(true);
    },
  );

  it("rejects host-owned delivery media constraints from public requests", () => {
    expect(
      Value.Check(AgentParamsSchema, {
        message: "deliver generated media",
        sessionKey: "agent:main:main",
        internalDeliveryMediaUrls: ["/tmp/proof.png"],
        idempotencyKey: "delivery-1",
      }),
    ).toBe(false);
  });
});

describe("MessageActionParamsSchema", () => {
  const baseParams = {
    channel: "matrix",
    action: "read",
    params: {},
    idempotencyKey: "idem-1",
  };

  it("accepts only the operation-local direct-operator marker", () => {
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        conversationReadOrigin: "direct-operator",
      }),
    ).toBe(true);
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        conversationReadOrigin: "delegated",
      }),
    ).toBe(false);
  });

  it("rejects caller-supplied current chat classification", () => {
    expect(
      Value.Check(MessageActionParamsSchema, {
        ...baseParams,
        toolContext: {
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
        },
      }),
    ).toBe(false);
  });

  it("validates closed reply routing facts", () => {
    for (const reply of [
      { replyToId: "message-1", source: "explicit" },
      { replyToId: "message-1", source: "implicit", mode: "first" },
      { replyToId: "message-1", source: "implicit", mode: "all" },
    ]) {
      expect(Value.Check(MessageActionParamsSchema, { ...baseParams, reply })).toBe(true);
    }
    for (const reply of [
      { replyToId: "message-1", source: "explicit", mode: "off" },
      { replyToId: "message-1", source: "implicit" },
      { replyToId: "message-1", source: "implicit", mode: "batched" },
    ]) {
      expect(Value.Check(MessageActionParamsSchema, { ...baseParams, reply })).toBe(false);
    }
  });
});

describe("Conversation schemas", () => {
  it("accepts Gateway-owned address discovery without session internals", () => {
    expect(
      Value.Check(ConversationListParamsSchema, {
        agentId: "main",
        channel: "reef",
        query: "@molty",
        limit: 50,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationListResultSchema, {
        conversations: [
          {
            conversationRef: "conv_0123456789abcdef0123456789abcdef",
            channel: "reef",
            accountId: "default",
            kind: "direct",
            target: "reef:molty",
            label: "@molty's agent",
            firstSeenAt: 100,
            lastSeenAt: 100,
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a Gateway-owned durable send and result", () => {
    expect(
      Value.Check(ConversationSendParamsSchema, {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "conversation-send-1",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationSendResultSchema, {
        status: "sent",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "reef",
        messageId: "01JZ0000000000000000000200",
        queueId: "conversation-send-1",
      }),
    ).toBe(true);
  });

  it("accepts a Gateway-owned correlated turn and its inline reply", () => {
    expect(
      Value.Check(ConversationTurnParamsSchema, {
        agentId: "main",
        sourceSessionKey: "agent:main:telegram:direct:operator",
        turnId: "conversation-turn-1",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        message: "hello",
        timeoutMs: 30_000,
      }),
    ).toBe(true);
    expect(
      Value.Check(ConversationTurnResultSchema, {
        status: "replied",
        conversationRef: "conv_0123456789abcdef0123456789abcdef",
        channel: "reef",
        messageId: "01JZ0000000000000000000200",
        correlationPersisted: true,
        reply: {
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          messageId: "01JZ0000000000000000000201",
          replyToId: "01JZ0000000000000000000200",
          text: "hello back",
          timestamp: 123,
        },
      }),
    ).toBe(true);
  });

  it("accepts explicit cancellation for an abandoned Gateway-owned turn", () => {
    expect(
      Value.Check(ConversationTurnCancelParamsSchema, {
        agentId: "main",
        turnId: "conversation-turn-1",
      }),
    ).toBe(true);
    expect(Value.Check(ConversationTurnCancelParamsSchema, { turnId: "conversation-turn-1" })).toBe(
      false,
    );
    expect(Value.Check(ConversationTurnCancelResultSchema, { cancelled: true })).toBe(true);
  });
});
