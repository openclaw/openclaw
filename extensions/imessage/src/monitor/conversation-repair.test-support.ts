import { describe, expect, it, vi } from "vitest";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import { createInboundDecisionParams } from "./inbound-decision.test-support.js";
import type { IMessagePayload } from "./types.js";

function anchorlessMessage(overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id: 9500,
    guid: "ANCHORLESS-GUID-1",
    chat_id: 0,
    sender: "+15550000001",
    destination_caller_id: "+15550000001",
    is_from_me: false,
    text: "https://example.com",
    chat_guid: "",
    chat_identifier: "",
    chat_name: "",
    participants: null,
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
      return {
        messages: chats.find((chat) => chat.id === params?.chat_id)?.messages ?? [],
      };
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

async function expectRecoveryDrop(chats: Parameters<typeof mockClient>[0], reason: string) {
  const runtime = { error: vi.fn() };
  await expect(
    repairIMessageConversationAnchor({
      client: mockClient(chats) as never,
      message: anchorlessMessage(),
      runtime,
    }),
  ).resolves.toBeNull();
  expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(reason);
}

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

    await expect(
      repairIMessageConversationAnchor({ client: client as never, message }),
    ).resolves.toBe(message);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("recovers the full authoritative projection from recent history by GUID", async () => {
    const message = anchorlessMessage();
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
      { id: 100, messages: [{ guid: "OTHER-GUID", chat_id: 100, is_group: true }] },
      { id: 349, messages: [{ guid: "ANCHORLESS-GUID-1", ...authoritative }] },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });

    expect(repaired).toMatchObject(authoritative);
  });

  it("clears stale destination_caller_id on the monitor path when history omits it", async () => {
    const { buildIMessageInboundContext, resolveIMessageInboundDecision } =
      await import("./inbound-processing.js");
    const message = anchorlessMessage({
      guid: "33333333-3333-4333-8333-333333333333",
      sender: "+15550000001",
      destination_caller_id: "+15550000001",
    });
    const client = mockClient([
      {
        id: 42,
        messages: [
          historyRow(42, {
            guid: "33333333-3333-4333-8333-333333333333",
            destination_caller_id: undefined,
          }),
        ],
      },
    ]);

    const repaired = await repairIMessageConversationAnchor({
      client: client as never,
      message,
    });
    expect(repaired?.sender).toBe("+15550000002");
    expect(repaired?.destination_caller_id ?? null).toBeNull();

    const decision = await resolveIMessageInboundDecision(
      createInboundDecisionParams({ message: repaired!, isKnownFromMeMessageId: undefined }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { imessageTo, ctxPayload } = await buildIMessageInboundContext({
      cfg: {} as never,
      accountService: undefined,
      decision,
      message: repaired!,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(imessageTo).toBe("imessage:+15550000002");
    expect(ctxPayload.To).toBe("chat_id:42");
  });

  it("drops fail-closed when authoritative history says is_from_me=true", async () => {
    await expectRecoveryDrop(
      [{ id: 42, messages: [historyRow(42, { is_from_me: true })] }],
      "recovered authoritative row is from-me",
    );
  });

  it("drops fail-closed when exact-GUID history projections conflict", async () => {
    await expectRecoveryDrop(
      [
        { id: 100, messages: [historyRow(100)] },
        {
          id: 200,
          messages: [
            historyRow(200, {
              chat_guid: "iMessage;-;+15550000003",
              chat_identifier: "+15550000003",
              sender: "+15550000003",
            }),
          ],
        },
      ],
      "conflicting exact-GUID history projections",
    );
  });

  it("drops fail-closed when the GUID cannot be matched", async () => {
    await expectRecoveryDrop(
      [{ id: 349, messages: [{ guid: "OTHER-GUID", chat_id: 349 }] }],
      "no recent chat matched",
    );
  });

  it("drops fail-closed when history finds the GUID but no usable anchor", async () => {
    await expectRecoveryDrop(
      [{ id: 349, messages: [historyRow(0, { chat_guid: "", chat_identifier: "" })] }],
      "exact-GUID history row is incomplete",
    );
  });
});
