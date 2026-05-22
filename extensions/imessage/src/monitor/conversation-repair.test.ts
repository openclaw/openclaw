import { describe, expect, it } from "vitest";
import { isIMessageAnchorless, repairIMessageConversationAnchor } from "./conversation-repair.js";
import type { IMessagePayload } from "./types.js";

function makeAnchorlessGroupLinkPreview(): IMessagePayload {
  return {
    id: 9500,
    guid: "F0F0F0F0-AAAA-BBBB-CCCC-DDDDDDDDDDDD",
    chat_id: 0,
    sender: "+15550001111",
    is_from_me: false,
    text: "https://example.com/article",
    attachments: null,
    chat_identifier: "",
    chat_guid: "",
    chat_name: "",
    participants: null,
    is_group: false,
  };
}

function makeValidGroupMessage(): IMessagePayload {
  return {
    id: 9501,
    guid: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
    chat_id: 349,
    sender: "+15550001111",
    is_from_me: false,
    text: "hello group",
    attachments: null,
    chat_identifier: "chat349",
    chat_guid: "iMessage;+;chat349",
    chat_name: "Test Group",
    participants: ["+15550001111", "+15550002222"],
    is_group: true,
  };
}

function makeValidDm(): IMessagePayload {
  return {
    id: 9502,
    guid: "DM-GUID-0001",
    chat_id: null,
    sender: "+15550001111",
    is_from_me: false,
    text: "hello dm",
    attachments: null,
    chat_identifier: "+15550001111",
    chat_guid: "iMessage;+;+15550001111",
    chat_name: null,
    participants: null,
    is_group: false,
  };
}

describe("isIMessageAnchorless", () => {
  it("returns true for chat_id=0 with empty chat_guid and chat_identifier", () => {
    expect(isIMessageAnchorless(makeAnchorlessGroupLinkPreview())).toBe(true);
  });

  it("returns true for chat_id=null with empty chat_guid and chat_identifier", () => {
    const msg = makeAnchorlessGroupLinkPreview();
    msg.chat_id = null;
    expect(isIMessageAnchorless(msg)).toBe(true);
  });

  it("returns true for chat_id=-1 with empty chat_guid and chat_identifier", () => {
    const msg = makeAnchorlessGroupLinkPreview();
    msg.chat_id = -1;
    expect(isIMessageAnchorless(msg)).toBe(true);
  });

  it("returns false for sender-only direct messages with undefined conversation fields", () => {
    const msg: IMessagePayload = {
      guid: "test",
      sender: "+15550001111",
      text: "hello",
    };
    expect(isIMessageAnchorless(msg)).toBe(false);
  });

  it("returns false for valid group message with positive chat_id", () => {
    expect(isIMessageAnchorless(makeValidGroupMessage())).toBe(false);
  });

  it("returns false when chat_guid is non-empty even with chat_id=0", () => {
    const msg = makeAnchorlessGroupLinkPreview();
    msg.chat_guid = "iMessage;+;chat349";
    expect(isIMessageAnchorless(msg)).toBe(false);
  });

  it("returns false when chat_identifier is non-empty even with chat_id=0", () => {
    const msg = makeAnchorlessGroupLinkPreview();
    msg.chat_identifier = "chat349";
    expect(isIMessageAnchorless(msg)).toBe(false);
  });

  it("returns false for DM with valid chat_identifier", () => {
    expect(isIMessageAnchorless(makeValidDm())).toBe(false);
  });
});

function mockClient(chats: Array<{ id: number; messages: Record<string, unknown>[] }>) {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  return {
    calls,
    request: async <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "chats.list") {
        return {
          chats: chats.map((c) => ({
            id: c.id,
            last_message_at: new Date().toISOString(),
          })),
        } as T;
      }
      if (method === "messages.history") {
        const chatId = params?.chat_id;
        const match = chats.find((c) => c.id === chatId);
        return { messages: match?.messages ?? [] } as T;
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
}

describe("repairIMessageConversationAnchor", () => {
  it("passes through non-anchorless messages unchanged", async () => {
    const msg = makeValidGroupMessage();
    const client = mockClient([]);
    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
    });
    expect(result).toBe(msg);
    expect(client.calls).toHaveLength(0);
  });

  it("passes through sender-only direct messages without recovery RPCs", async () => {
    const msg: IMessagePayload = {
      guid: "sender-only-dm",
      sender: "+15550001111",
      is_from_me: false,
      text: "hello dm",
    };
    const client = mockClient([]);
    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
    });
    expect(result).toBe(msg);
    expect(client.calls).toHaveLength(0);
  });

  it("recovers group conversation from messages.history by GUID", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    const historyEntry = {
      id: 9500,
      guid: msg.guid,
      chat_id: 349,
      chat_guid: "iMessage;+;chat349",
      chat_identifier: "chat349",
      chat_name: "Test Group",
      is_group: true,
      participants: ["+15550001111", "+15550002222"],
      sender: "+15550001111",
      text: "https://example.com/article",
      is_from_me: false,
    };
    const client = mockClient([{ id: 349, messages: [historyEntry] }]);

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
    });

    expect(result).not.toBeNull();
    expect(result!.chat_id).toBe(349);
    expect(result!.chat_guid).toBe("iMessage;+;chat349");
    expect(result!.chat_identifier).toBe("chat349");
    expect(result!.is_group).toBe(true);
    expect(result!.chat_name).toBe("Test Group");
    expect(result!.participants).toEqual(["+15550001111", "+15550002222"]);
  });

  it("returns null when anchorless and GUID is missing", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    msg.guid = null;
    const client = mockClient([]);
    const logs: string[] = [];

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
      runtime: { error: (m) => logs.push(m) },
    });

    expect(result).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("without GUID");
  });

  it("returns null when GUID is not found in any chat history", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    const client = mockClient([
      {
        id: 100,
        messages: [{ guid: "other-guid-1", chat_id: 100, is_group: true }],
      },
      {
        id: 200,
        messages: [{ guid: "other-guid-2", chat_id: 200, is_group: false }],
      },
    ]);
    const logs: string[] = [];

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
      runtime: { error: (m) => logs.push(m) },
    });

    expect(result).toBeNull();
    expect(logs.some((l) => l.includes("not found"))).toBe(true);
  });

  it("returns null when chats.list RPC fails", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    const client = {
      request: async () => {
        throw new Error("RPC unavailable");
      },
    };
    const logs: string[] = [];

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
      runtime: { error: (m) => logs.push(m) },
    });

    expect(result).toBeNull();
    expect(logs.some((l) => l.includes("chats.list error"))).toBe(true);
  });

  it("continues scanning after a per-chat messages.history failure", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    const targetGuid = msg.guid!;
    const goodEntry = {
      id: 9500,
      guid: targetGuid,
      chat_id: 349,
      chat_guid: "iMessage;+;chat349",
      chat_identifier: "chat349",
      is_group: true,
      participants: ["+15550001111"],
      sender: "+15550001111",
      text: "test",
    };
    let chatsListed = false;
    let chatId100Queried = false;
    const client = {
      request: async <T = unknown>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T> => {
        if (method === "chats.list") {
          chatsListed = true;
          return {
            chats: [
              { id: 100, last_message_at: new Date().toISOString() },
              { id: 349, last_message_at: new Date().toISOString() },
            ],
          } as T;
        }
        if (method === "messages.history") {
          if (params?.chat_id === 100) {
            chatId100Queried = true;
            throw new Error("history unavailable");
          }
          if (params?.chat_id === 349) {
            return { messages: [goodEntry] } as T;
          }
        }
        throw new Error(`unexpected: ${method}`);
      },
    };

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
    });

    expect(chatId100Queried).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.chat_id).toBe(349);
    expect(result!.is_group).toBe(true);
  });

  it("returns null when recovered fields are all invalid (still anchorless)", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    const entry = {
      id: 9500,
      guid: msg.guid,
      chat_id: 0,
      chat_guid: "",
      chat_identifier: "",
      is_group: "yes",
      participants: "not-array",
      sender: "+15550001111",
    };
    const client = mockClient([{ id: 1, messages: [entry] }]);
    const logs: string[] = [];

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
      runtime: { error: (m) => logs.push(m) },
    });

    // GUID found but no valid anchor fields recovered — fail-closed.
    expect(result).toBeNull();
    expect(logs.some((l) => l.includes("no valid anchor fields recovered"))).toBe(true);
  });

  it("respects chatsLimit parameter", async () => {
    const msg = makeAnchorlessGroupLinkPreview();
    let chatsLimitReceived: number | undefined;
    const client = {
      request: async <T = unknown>(
        method: string,
        params?: Record<string, unknown>,
      ): Promise<T> => {
        if (method === "chats.list") {
          chatsLimitReceived = params?.limit as number;
          return { chats: [] } as T;
        }
        return { messages: [] } as T;
      },
    };

    const result = await repairIMessageConversationAnchor({
      message: msg,
      client: client as never,
      chatsLimit: 5,
    });

    // chatsLimit is passed through to chats.list; empty result means drop.
    expect(chatsLimitReceived).toBe(5);
    expect(result).toBeNull();
  });
});
