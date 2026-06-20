// Telegram tests cover session conversation plugin behavior.
import { describe, expect, it } from "vitest";
import {
  parseTelegramDirectSessionKey,
  resolveTelegramSessionConversation,
  resolveTelegramSessionTarget,
} from "./session-conversation.js";

describe("resolveTelegramSessionConversation", () => {
  it("owns topic session parsing and parent fallback candidates", () => {
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001:topic:77",
      }),
    ).toEqual({
      id: "-1001",
      threadId: "77",
      baseConversationId: "-1001",
      parentConversationCandidates: ["-1001"],
    });
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001:Topic:77",
      }),
    ).toEqual({
      id: "-1001",
      threadId: "77",
      baseConversationId: "-1001",
      parentConversationCandidates: ["-1001"],
    });
    expect(
      resolveTelegramSessionConversation({
        kind: "group",
        rawId: "-1001",
      }),
    ).toBeNull();
  });
});

describe("parseTelegramDirectSessionKey", () => {
  it("parses direct sessions with optional DM topic suffixes", () => {
    expect(parseTelegramDirectSessionKey("agent:31:telegram:direct:172724380")).toEqual({
      agentId: "31",
      baseSessionKey: "agent:31:telegram:direct:172724380",
      chatId: "172724380",
    });
    expect(
      parseTelegramDirectSessionKey("agent:31:telegram:direct:172724380:thread:172724380:440162"),
    ).toEqual({
      agentId: "31",
      baseSessionKey: "agent:31:telegram:direct:172724380",
      chatId: "172724380",
      messageThreadId: 440162,
      threadId: "172724380:440162",
    });
  });

  it("parses account-scoped direct sessions and raw parsed rest values", () => {
    expect(
      parseTelegramDirectSessionKey("agent:31:telegram:personal:direct:172724380:thread:440162"),
    ).toEqual({
      accountId: "personal",
      agentId: "31",
      baseSessionKey: "agent:31:telegram:personal:direct:172724380",
      chatId: "172724380",
      messageThreadId: 440162,
      threadId: "440162",
    });
    expect(parseTelegramDirectSessionKey("telegram:direct:172724380:thread:440162")).toEqual({
      baseSessionKey: "telegram:direct:172724380",
      chatId: "172724380",
      messageThreadId: 440162,
      threadId: "440162",
    });
  });

  it("rejects non-direct Telegram sessions", () => {
    expect(parseTelegramDirectSessionKey("agent:31:telegram:group:-1001:topic:7")).toBeNull();
  });
});

describe("resolveTelegramSessionTarget", () => {
  it("normalizes group session ids to numeric chat ids", () => {
    expect(resolveTelegramSessionTarget({ kind: "group", id: "-1001" })).toBe("-1001");
  });

  it("normalizes channel session ids to lookup targets", () => {
    expect(resolveTelegramSessionTarget({ kind: "channel", id: "@OpenClawTeam" })).toBe(
      "@OpenClawTeam",
    );
  });
});
