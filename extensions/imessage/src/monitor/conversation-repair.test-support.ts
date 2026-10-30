import { describe, expect, it, vi } from "vitest";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import { admitIMessageContext } from "./inbound-context.test-helpers.js";
import type { IMessagePayload } from "./types.js";

function anchorlessMessage(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    guid: "ANCHORLESS-GUID-1",
    chat_id: 0,
    sender: "+15550000001",
    destination_caller_id: "+15550000001",
    is_from_me: false,
    text: "https://example.com",
    chat_guid: "",
    chat_identifier: "",
    is_group: false,
    ...overrides,
  };
}

function mockClient(chats: Array<{ id: number; messages: Record<string, unknown>[] }>) {
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "chats.list") {
      return { chats: chats.map((chat) => ({ id: chat.id })) };
    }
    if (method === "messages.history") {
      return { messages: chats.find((chat) => chat.id === params?.chat_id)?.messages ?? [] };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { request };
}

function historyRow(chatId = 42, overrides: Record<string, unknown> = {}) {
  return {
    guid: "ANCHORLESS-GUID-1",
    chat_id: chatId,
    chat_guid: "iMessage;-;+15550000002",
    chat_identifier: "+15550000002",
    sender: "+15550000002",
    destination_caller_id: "+15550000001",
    is_from_me: false,
    is_group: false,
    ...overrides,
  };
}

const chat = (id: number, ...messages: Record<string, unknown>[]) => ({ id, messages });
const repair = (client: ReturnType<typeof mockClient>, message = anchorlessMessage()) =>
  repairIMessageConversationAnchor({ client: client as never, message });

describe("repairIMessageConversationAnchor", () => {
  it.each([
    anchorlessMessage({ chat_id: 349, is_group: true }),
    anchorlessMessage({ chat_guid: "iMessage;+;chat349", is_group: true }),
    anchorlessMessage({ chat_identifier: "chat349", is_group: true }),
    {
      guid: "DM-GUID",
      sender: "+15550001111",
      is_from_me: false,
      text: "hello",
    } satisfies IMessagePayload,
  ])("passes through anchored and sender-only messages without recovery RPCs", async (message) => {
    const client = mockClient([]);

    await expect(repair(client, message)).resolves.toBe(message);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("recovers the full authoritative projection from recent history by GUID", async () => {
    const authoritative = {
      chat_id: 349,
      chat_guid: "iMessage;+;chat349",
      chat_identifier: "chat349",
      chat_name: "Project group",
      participants: ["+15550001111", "+15550002222"],
      sender: "+15550002222",
      destination_caller_id: "+15550001111",
      is_from_me: false,
      is_group: true,
    };
    const client = mockClient([
      chat(100, { guid: "OTHER-GUID", chat_id: 100, is_group: true }),
      chat(349, { guid: "ANCHORLESS-GUID-1", ...authoritative }),
    ]);
    expect(await repair(client)).toMatchObject(authoritative);
  });

  it("clears stale destination_caller_id on the monitor path when history omits it", async () => {
    const message = anchorlessMessage({
      guid: "33333333-3333-4333-8333-333333333333",
    });
    const client = mockClient([
      chat(42, historyRow(42, { guid: message.guid, destination_caller_id: undefined })),
    ]);
    const repaired = await repair(client, message);
    expect(repaired).toMatchObject({ sender: "+15550000002", destination_caller_id: null });

    const { context } = await admitIMessageContext({ message: repaired! });
    const { imessageTo, ctxPayload } = await context();

    expect(imessageTo).toBe("imessage:+15550000002");
    expect(ctxPayload.To).toBe("chat_id:42");
  });

  it.each([
    [
      "conflicting exact-GUID history projections",
      [chat(100, historyRow(100)), chat(200, historyRow(200))],
    ],
    ["no recent chat matched", [chat(349, { guid: "OTHER-GUID", chat_id: 349 })]],
    [
      "exact-GUID history row is incomplete",
      [chat(349, historyRow(0, { chat_guid: "", chat_identifier: "" }))],
    ],
  ] satisfies Array<[string, Parameters<typeof mockClient>[0]]>)(
    "drops fail-closed: %s",
    async (_reason, chats) => {
      await expect(repair(mockClient(chats))).resolves.toBeNull();
    },
  );
});
