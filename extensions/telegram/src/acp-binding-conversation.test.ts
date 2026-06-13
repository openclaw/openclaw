import { describe, expect, it } from "vitest";
import {
  compileTelegramAcpConversation,
  matchTelegramAcpConversation,
} from "./acp-binding-conversation.js";

const GROUP_TOPIC_ID = "-1001234567890:topic:42";
const GROUP_CHAT_ID = "-1001234567890";
const DIRECT_PEER_ID = "8517390162";

describe("compileTelegramAcpConversation", () => {
  it("compiles a direct-peer binding to the bare peer id with no parent", () => {
    expect(
      compileTelegramAcpConversation({ peerKind: "direct", conversationId: DIRECT_PEER_ID }),
    ).toEqual({
      conversationId: DIRECT_PEER_ID,
      parentConversationId: undefined,
    });
  });

  it("accepts the legacy dm peer kind alias", () => {
    expect(
      compileTelegramAcpConversation({ peerKind: "dm", conversationId: DIRECT_PEER_ID }),
    ).toEqual({
      conversationId: DIRECT_PEER_ID,
      parentConversationId: undefined,
    });
  });

  it("accepts an explicit direct:<userId> config form", () => {
    expect(
      compileTelegramAcpConversation({
        peerKind: "direct",
        conversationId: `direct:${DIRECT_PEER_ID}`,
      }),
    ).toEqual({
      conversationId: DIRECT_PEER_ID,
      parentConversationId: undefined,
    });
  });

  it("still compiles group/topic bindings to the canonical topic ref", () => {
    expect(
      compileTelegramAcpConversation({ peerKind: "group", conversationId: GROUP_TOPIC_ID }),
    ).toEqual({
      conversationId: GROUP_TOPIC_ID,
      parentConversationId: GROUP_CHAT_ID,
    });
  });

  it("does not compile a positive peer id when no direct kind is set", () => {
    expect(
      compileTelegramAcpConversation({ peerKind: "group", conversationId: DIRECT_PEER_ID }),
    ).toBeNull();
  });

  it("does not compile a group id under a direct binding", () => {
    expect(
      compileTelegramAcpConversation({ peerKind: "direct", conversationId: GROUP_CHAT_ID }),
    ).toBeNull();
  });
});

describe("matchTelegramAcpConversation", () => {
  it("matches an inbound DM (positive id, no parent) to a direct binding", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "direct",
        bindingConversationId: DIRECT_PEER_ID,
        conversationId: DIRECT_PEER_ID,
      }),
    ).toEqual({
      conversationId: DIRECT_PEER_ID,
      parentConversationId: undefined,
      matchPriority: 2,
    });
  });

  it("matches via the legacy dm alias", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "dm",
        bindingConversationId: DIRECT_PEER_ID,
        conversationId: DIRECT_PEER_ID,
      }),
    ).toEqual({
      conversationId: DIRECT_PEER_ID,
      parentConversationId: undefined,
      matchPriority: 2,
    });
  });

  it("does not match a different DM peer", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "direct",
        bindingConversationId: DIRECT_PEER_ID,
        conversationId: "9999999999",
      }),
    ).toBeNull();
  });

  it("does not match a group/topic inbound to a direct binding", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "direct",
        bindingConversationId: DIRECT_PEER_ID,
        conversationId: "42",
        parentConversationId: GROUP_CHAT_ID,
      }),
    ).toBeNull();
  });

  it("does not match an inbound DM to a group binding", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "group",
        bindingConversationId: GROUP_TOPIC_ID,
        conversationId: DIRECT_PEER_ID,
      }),
    ).toBeNull();
  });

  it("still matches a group/topic inbound to a group binding", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "group",
        bindingConversationId: GROUP_TOPIC_ID,
        conversationId: "42",
        parentConversationId: GROUP_CHAT_ID,
      }),
    ).toEqual({
      conversationId: GROUP_TOPIC_ID,
      parentConversationId: GROUP_CHAT_ID,
      matchPriority: 2,
    });
  });

  it("matches a direct topic-form inbound id back to the same canonical id", () => {
    expect(
      matchTelegramAcpConversation({
        peerKind: "group",
        bindingConversationId: GROUP_TOPIC_ID,
        conversationId: GROUP_TOPIC_ID,
      }),
    ).toEqual({
      conversationId: GROUP_TOPIC_ID,
      parentConversationId: GROUP_CHAT_ID,
      matchPriority: 2,
    });
  });
});
