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
import { accepts, rejects } from "./schema.test-support.js";

describe("AgentParamsSchema", () => {
  const request = { message: "resume", idempotencyKey: "creation" };
  it.each([undefined, false, true, "true"])(
    "accepts only boolean session creation intent (%s)",
    (createSessionIfMissing) => {
      expect(
        Value.Check(AgentParamsSchema, {
          ...request,
          sessionId: "named-session",
          createSessionIfMissing,
        }),
      ).toBe(createSessionIfMissing !== "true");
    },
  );

  it("accepts the backend expected-session binding without a revision", () => {
    accepts(AgentParamsSchema, {
      ...request,
      sessionKey: "agent:main:main",
      expectedExistingSessionId: "session-1",
      expectedExistingSessionLifecycleRevision: undefined,
      idempotencyKey: "recovery-1",
    });
  });
});

describe("MessageActionParamsSchema", () => {
  const baseParams = { channel: "matrix", action: "read", params: {}, idempotencyKey: "idem-1" };

  it("accepts only the operation-local direct-operator marker", () => {
    accepts(MessageActionParamsSchema, {
      ...baseParams,
      conversationReadOrigin: "direct-operator",
    });
    rejects(MessageActionParamsSchema, { ...baseParams, conversationReadOrigin: "delegated" });
  });

  it("rejects caller-supplied current chat classification", () => {
    rejects(MessageActionParamsSchema, {
      ...baseParams,
      toolContext: { currentChannelId: "!room:example.org", currentChatType: "direct" },
    });
  });

  it("validates closed reply routing facts", () => {
    for (const reply of [
      { replyToId: "message-1", source: "explicit" },
      { replyToId: "message-1", source: "implicit", mode: "first" },
      { replyToId: "message-1", source: "implicit", mode: "all" },
    ]) {
      accepts(MessageActionParamsSchema, { ...baseParams, reply });
    }
    for (const reply of [
      { replyToId: "message-1", source: "explicit", mode: "off" },
      { replyToId: "message-1", source: "implicit" },
      { replyToId: "message-1", source: "implicit", mode: "batched" },
    ]) {
      rejects(MessageActionParamsSchema, { ...baseParams, reply });
    }
  });
});

describe("Conversation schemas", () => {
  const conversationRef = "conv_0123456789abcdef0123456789abcdef";
  const address = { conversationRef, channel: "reef" };
  const request = {
    agentId: "main",
    sourceSessionKey: "agent:main:telegram:direct:operator",
    conversationRef,
    message: "hello",
  };
  const delivery = { ...address, messageId: "01JZ0000000000000000000200" };
  it("accepts Gateway-owned address discovery without session internals", () => {
    accepts(ConversationListParamsSchema, {
      agentId: "main",
      channel: "reef",
      query: "@molty",
      limit: 50,
    });
    accepts(ConversationListResultSchema, {
      conversations: [
        {
          ...address,
          accountId: "default",
          kind: "direct",
          target: "reef:molty",
          label: "@molty's agent",
          firstSeenAt: 100,
          lastSeenAt: 100,
        },
      ],
    });
  });

  it("accepts a Gateway-owned durable send and result", () => {
    accepts(ConversationSendParamsSchema, { ...request, operationId: "conversation-send-1" });
    accepts(ConversationSendResultSchema, {
      status: "sent",
      ...delivery,
      queueId: "conversation-send-1",
    });
  });

  it("accepts a Gateway-owned correlated turn and its inline reply", () => {
    accepts(ConversationTurnParamsSchema, {
      ...request,
      turnId: "conversation-turn-1",
      timeoutMs: 30_000,
    });
    accepts(ConversationTurnResultSchema, {
      status: "replied",
      ...delivery,
      correlationPersisted: true,
      reply: {
        conversationRef,
        messageId: "01JZ0000000000000000000201",
        replyToId: "01JZ0000000000000000000200",
        text: "hello back",
        timestamp: 123,
      },
    });
  });

  it("accepts explicit cancellation for an abandoned Gateway-owned turn", () => {
    accepts(ConversationTurnCancelParamsSchema, { agentId: "main", turnId: "conversation-turn-1" });
    rejects(ConversationTurnCancelParamsSchema, { turnId: "conversation-turn-1" });
    accepts(ConversationTurnCancelResultSchema, { cancelled: true });
  });
});
