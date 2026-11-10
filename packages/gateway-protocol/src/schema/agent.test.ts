import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import * as S from "./agent.js";
import { schemaValidation, withOverrides } from "./protocol-validation.test-support.js";
import { accepts, rejects } from "./schema.test-support.js";

describe("AgentParamsSchema", () => {
  const request = { message: "resume", idempotencyKey: "creation" };
  it.each([undefined, false, true, "true"])(
    "accepts only boolean session creation intent (%s)",
    (createSessionIfMissing) => {
      const value = { ...request, sessionId: "named-session", createSessionIfMissing };
      expect(Value.Check(S.AgentParamsSchema, value)).toBe(createSessionIfMissing !== "true");
    },
  );

  it("accepts the backend expected-session binding without a revision", () => {
    accepts(S.AgentParamsSchema, {
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
    accepts(S.MessageActionParamsSchema, {
      ...baseParams,
      conversationReadOrigin: "direct-operator",
    });
    rejects(S.MessageActionParamsSchema, { ...baseParams, conversationReadOrigin: "delegated" });
  });

  it("rejects caller-supplied current chat classification", () => {
    rejects(S.MessageActionParamsSchema, {
      ...baseParams,
      toolContext: { currentChannelId: "!room:example.org", currentChatType: "direct" },
    });
  });

  it("validates closed reply routing facts", () => {
    const reply = withOverrides({ replyToId: "message-1", source: "implicit" });
    const action = schemaValidation(S.MessageActionParamsSchema);
    const request = (facts: object) => ({ ...baseParams, reply: facts });
    action.accepts(
      ...[reply({ source: "explicit" }), reply({ mode: "first" }), reply({ mode: "all" })].map(
        request,
      ),
    );
    action.rejects(
      ...[reply({ source: "explicit", mode: "off" }), reply({}), reply({ mode: "batched" })].map(
        request,
      ),
    );
  });
});

describe("Conversation schemas", () => {
  const conversationRef = "conv_0123456789abcdef0123456789abcdef";
  const request = {
    agentId: "main",
    sourceSessionKey: "agent:main:telegram:direct:operator",
    conversationRef,
    message: "hello",
  };
  it("accepts Gateway-owned address discovery without session internals", () => {
    accepts(S.ConversationListParamsSchema, {
      agentId: "main",
      channel: "reef",
      query: "@molty",
      limit: 50,
    });
  });

  it("accepts a Gateway-owned durable send", () => {
    accepts(S.ConversationSendParamsSchema, { ...request, operationId: "conversation-send-1" });
  });

  it("accepts a Gateway-owned correlated turn", () => {
    accepts(S.ConversationTurnParamsSchema, {
      ...request,
      turnId: "conversation-turn-1",
      timeoutMs: 30_000,
    });
  });

  it("accepts explicit cancellation for an abandoned Gateway-owned turn", () => {
    accepts(S.ConversationTurnCancelParamsSchema, {
      agentId: "main",
      turnId: "conversation-turn-1",
    });
    rejects(S.ConversationTurnCancelParamsSchema, { turnId: "conversation-turn-1" });
    accepts(S.ConversationTurnCancelResultSchema, { cancelled: true });
  });
});
