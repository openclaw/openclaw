import { describe, expect, it } from "vitest";
import {
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../../auto-reply/reply/source-turn-id.js";
import {
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../../../gateway/message-action-turn-capability.js";
import { createTurnAuthoritySnapshot } from "../../../plugins/turn-authority.js";
import { createRecoveryMessageActionTurnCapability } from "./recovery-message-action-capability.js";

function createParams() {
  return {
    agentId: "main",
    agentAccountId: "work",
    currentChannelId: "chat-1",
    isAuthorizedSender: true,
    messageProvider: "telegram",
    messageTo: "chat-1",
    parentConversationId: "parent-chat",
    runId: "recovery-run-1",
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:direct:chat-1",
    senderId: "user-1",
    timeoutMs: 60_000,
  };
}

describe("createRecoveryMessageActionTurnCapability", () => {
  it("mints exact source correlation for a reconstructed channel run", () => {
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "telegram",
        accountId: "work",
        senderId: "user-1",
        isAuthorizedSender: true,
      },
      agentId: "main",
      runId: "recovery-run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      conversationId: "chat-1",
      parentConversationId: "parent-chat",
      trigger: "user",
    });
    const params = { ...createParams(), turnAuthority };
    setChannelSourceTurnId(params, "channel-user:v1:source-1");
    setChannelSourceTurnSameThreadRequired(params, true);
    const token = createRecoveryMessageActionTurnCapability(params);
    expect(token).toEqual(expect.any(String));
    const resolved = resolveMessageActionTurnCapability({
      token,
      agentId: "main",
      runId: "recovery-run-1",
      sessionKey: "agent:main:telegram:direct:chat-1",
      sessionId: "session-1",
    });
    expect(resolved).toMatchObject({
      requesterAccountId: "work",
      requesterSenderId: "user-1",
      requesterIsAuthorizedSender: true,
      parentConversationId: "parent-chat",
      toolContext: {
        currentChannelId: "chat-1",
        currentChannelProvider: "telegram",
        currentSourceTurnId: "channel-user:v1:source-1",
        sameChannelThreadRequired: true,
      },
    });
    expect(resolved?.turnAuthority).toBe(turnAuthority);
    revokeMessageActionTurnCapability(token);
  });

  it("fails closed when recovered authority does not match the run identity", () => {
    const params = {
      ...createParams(),
      turnAuthority: createTurnAuthoritySnapshot({
        principal: { kind: "sender", senderId: "user-1" },
        agentId: "main",
        runId: "different-run",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }),
    };
    setChannelSourceTurnId(params, "channel-user:v1:source-1");

    expect(() => createRecoveryMessageActionTurnCapability(params)).toThrow(
      "message action turn authority does not match execution identity",
    );
  });

  it("does not mint without durable source correlation", () => {
    expect(createRecoveryMessageActionTurnCapability(createParams())).toBeUndefined();
  });

  it("keeps an unlimited recovered run authorized until run cleanup", () => {
    const params = { ...createParams(), timeoutMs: 0 };
    setChannelSourceTurnId(params, "channel-user:v1:source-1");
    const token = createRecoveryMessageActionTurnCapability(params);
    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "recovery-run-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ expiresAtMs: Number.MAX_SAFE_INTEGER });
    revokeMessageActionTurnCapability(token);
  });
});
