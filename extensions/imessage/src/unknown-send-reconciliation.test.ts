import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { reconcileIMessageUnknownSend } from "./unknown-send-reconciliation.js";

const attemptStartedAt = Date.parse("2026-07-29T02:00:00.000Z");

function createContext(
  overrides: Partial<ChannelMessageUnknownSendContext> = {},
): ChannelMessageUnknownSendContext {
  return {
    cfg: {
      channels: {
        imessage: {
          cliPath: "/opt/openclaw/bin/remote-imsg",
          probeTimeoutMs: 150_000,
        },
      },
    } as OpenClawConfig,
    queueId: "queue-1",
    channel: "imessage",
    to: "+15551234567",
    accountId: "default",
    enqueuedAt: attemptStartedAt - 1_000,
    platformSendStartedAt: attemptStartedAt,
    retryCount: 0,
    payloads: [{ text: "hello" }],
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 88,
    guid: "p:0/MSG-GUID-1",
    chat_id: 42,
    sender: "me",
    is_from_me: true,
    text: "hello",
    created_at: "2026-07-29T02:00:02.000Z",
    chat_identifier: "+15551234567",
    participants: ["+15551234567"],
    ...overrides,
  };
}

function createClient(params?: {
  chats?: unknown[];
  messages?: unknown[];
  messagesByChatId?: Record<number, unknown[]>;
  historyError?: Error;
  sendStatus?: Record<string, unknown>;
  sendStatusError?: Error;
  stopError?: Error;
}) {
  const request = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
    if (method === "chats.list") {
      return {
        chats: params?.chats ?? [
          {
            id: 42,
            identifier: "+1 (555) 123-4567",
            guid: "iMessage;-;+15551234567",
            service: "iMessage",
            participants: ["+15551234567"],
            is_group: false,
          },
        ],
      };
    }
    if (method === "message.send_status") {
      if (params?.sendStatusError) {
        throw params.sendStatusError;
      }
      return (
        params?.sendStatus ?? {
          ok: true,
          guid: payload?.guid,
          send_state: "delivered",
          checked_at: "2026-07-29T02:03:00.000Z",
        }
      );
    }
    if (params?.historyError) {
      throw params.historyError;
    }
    const chatId = typeof payload?.chat_id === "number" ? payload.chat_id : undefined;
    return {
      messages: (chatId === undefined ? undefined : params?.messagesByChatId?.[chatId]) ??
        params?.messages ?? [historyRow()],
    };
  });
  const stop = vi.fn(async () => {
    if (params?.stopError) {
      throw params.stopError;
    }
  });
  const client = { request, stop };
  return client as typeof client & Pick<IMessageRpcClient, "request" | "stop">;
}

describe("reconcileIMessageUnknownSend", () => {
  it("reconciles one exact outbound row through the configured RPC transport", async () => {
    const client = createClient();

    const result = await reconcileIMessageUnknownSend(createContext(), { client });

    expect(result).toMatchObject({
      status: "sent",
      messageId: "p:0/MSG-GUID-1",
      receipt: {
        primaryPlatformMessageId: "p:0/MSG-GUID-1",
        platformMessageIds: ["p:0/MSG-GUID-1"],
        sentAt: Date.parse("2026-07-29T02:00:02.000Z"),
      },
    });
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "chats.list",
      { limit: 100 },
      { timeoutMs: 10_000 },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "messages.history",
      {
        chat_id: 42,
        limit: 100,
        start: "2026-07-29T02:00:00.000Z",
        end: "2026-07-29T02:02:30.000Z",
        attachments: false,
      },
      { timeoutMs: 10_000 },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      3,
      "message.send_status",
      { guid: "MSG-GUID-1" },
      { timeoutMs: 10_000 },
    );
    expect(client.stop).not.toHaveBeenCalled();
  });

  it("sanitizes the pre-delivery rendered plan before matching wire text", async () => {
    const client = createClient({
      messages: [historyRow({ text: "Visible reply" })],
    });

    await expect(
      reconcileIMessageUnknownSend(
        createContext({
          payloads: [{ text: "Visible reply\n\nassistant:" }],
          renderedBatchPlan: {
            payloadCount: 1,
            textCount: 1,
            mediaCount: 0,
            voiceCount: 0,
            presentationCount: 0,
            interactiveCount: 0,
            channelDataCount: 0,
            items: [
              {
                index: 0,
                kinds: ["text"],
                text: "Visible reply\n\nassistant:",
                mediaUrls: [],
              },
            ],
          },
        }),
        { client },
      ),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("uses chat_id directly without a chat-list lookup", async () => {
    const client = createClient();

    await expect(
      reconcileIMessageUnknownSend(createContext({ to: "chat_id:42" }), { client }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      "messages.history",
      expect.objectContaining({ chat_id: 42 }),
      { timeoutMs: 10_000 },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "message.send_status",
      { guid: "MSG-GUID-1" },
      { timeoutMs: 10_000 },
    );
  });

  it.each([
    {
      label: "chat GUID",
      to: "chat_guid:iMessage;+;chat-42",
      chat: { id: 42, guid: "iMessage;+;chat-42", service: "iMessage" },
    },
    {
      label: "chat identifier",
      to: "chat_identifier:group-42",
      chat: { id: 42, identifier: "group-42", service: "iMessage" },
    },
  ])("resolves an exact $label through chats.list", async ({ to, chat }) => {
    const client = createClient({ chats: [chat] });

    await expect(
      reconcileIMessageUnknownSend(createContext({ to }), { client }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "messages.history",
      expect.objectContaining({ chat_id: 42 }),
      { timeoutMs: 10_000 },
    );
  });

  it("uses an explicit service to select the unique chat for a shared handle", async () => {
    const shared = {
      identifier: "+15551234567",
      participants: ["+15551234567"],
      is_group: false,
    };
    const client = createClient({
      chats: [
        { ...shared, id: 41, guid: "SMS;-;+15551234567", service: "SMS" },
        { ...shared, id: 42, guid: "iMessage;-;+15551234567", service: "iMessage" },
      ],
    });

    await expect(
      reconcileIMessageUnknownSend(createContext({ to: "imessage:+15551234567" }), { client }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "messages.history",
      expect.objectContaining({ chat_id: 42 }),
      { timeoutMs: 10_000 },
    );
  });

  it("never uses a group containing the target handle as proof of a direct send", async () => {
    const client = createClient({
      chats: [
        {
          id: 41,
          identifier: "group-41",
          service: "iMessage",
          participants: ["+15551234567", "+15557654321"],
          is_group: true,
        },
        {
          id: 42,
          identifier: "+15551234567",
          service: "iMessage",
          participants: ["+15551234567"],
          is_group: false,
        },
      ],
      messagesByChatId: {
        41: [historyRow({ chat_id: 41, guid: "GROUP-MESSAGE" })],
        42: [historyRow()],
      },
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toMatchObject({
      status: "sent",
      messageId: "p:0/MSG-GUID-1",
    });
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      "messages.history",
      expect.objectContaining({ chat_id: 42 }),
      { timeoutMs: 10_000 },
    );
  });

  it("matches the exact reply target when reconciling threaded text", async () => {
    const client = createClient({
      messages: [
        historyRow({ guid: "wrong-reply", reply_to_guid: "p:0/OTHER" }),
        historyRow({
          guid: "right-reply",
          reply_to_guid: "PARENT-GUID",
          associated_message_guid: "p:0/PARENT-GUID",
        }),
      ],
    });

    const result = await reconcileIMessageUnknownSend(
      createContext({ effectiveReplyToId: "p:0/PARENT-GUID" }),
      { client },
    );

    expect(result).toMatchObject({
      status: "sent",
      messageId: "right-reply",
      receipt: { replyToId: "PARENT-GUID" },
    });
  });

  it("searches duplicate exact chats and reconciles only one global outbound row", async () => {
    const shared = {
      identifier: "+15551234567",
      service: "iMessage",
      participants: ["+15551234567"],
      is_group: false,
    };
    const client = createClient({
      chats: [
        { ...shared, id: 42 },
        { ...shared, id: 43 },
      ],
      messagesByChatId: {
        42: [historyRow()],
        43: [historyRow({ chat_id: 43, text: "different" })],
      },
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toMatchObject({
      status: "sent",
      messageId: "p:0/MSG-GUID-1",
    });
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it("keeps duplicate exact chats unresolved when each contains a matching row", async () => {
    const shared = {
      identifier: "+15551234567",
      service: "iMessage",
      participants: ["+15551234567"],
      is_group: false,
    };
    const client = createClient({
      chats: [
        { ...shared, id: 42 },
        { ...shared, id: 43 },
      ],
      messagesByChatId: {
        42: [historyRow()],
        43: [historyRow({ chat_id: 43, guid: "MSG-GUID-2" })],
      },
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage history contains multiple exact outbound candidates",
      retryable: false,
    });
  });

  it("retries reconciliation, never delivery, when no exact target chat is visible yet", async () => {
    const client = createClient({ chats: [] });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage reconciliation found no exact target chat",
      retryable: true,
    });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("fails closed before history reads when the target-chat set is unbounded", async () => {
    const client = createClient({
      chats: Array.from({ length: 21 }, (_, index) => ({
        id: index + 1,
        identifier: "+15551234567",
        service: "iMessage",
        participants: ["+15551234567"],
        is_group: false,
      })),
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage reconciliation found more than 20 exact target chats",
      retryable: false,
    });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing send-start timestamp before opening an RPC client", async () => {
    const createClientMock = vi.fn();

    const result = await reconcileIMessageUnknownSend(
      createContext({ platformSendStartedAt: undefined }),
      { createClient: createClientMock },
    );

    expect(result).toEqual({
      status: "unresolved",
      error: "iMessage reconciliation requires a platform send start timestamp",
      retryable: false,
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("fails closed when multiple exact outbound rows exist", async () => {
    const client = createClient({
      messages: [historyRow(), historyRow({ id: 89, guid: "MSG-GUID-2" })],
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage history contains multiple exact outbound candidates",
      retryable: false,
    });
  });

  it("never treats history absence as proof that replay is safe", async () => {
    const client = createClient({
      messages: [
        historyRow({ is_from_me: false }),
        historyRow({ guid: "earlier", created_at: "2026-07-29T01:59:59.999Z" }),
        historyRow({ guid: "late", created_at: "2026-07-29T02:03:00.000Z" }),
        historyRow({ guid: "different", text: "different" }),
      ],
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage history contains no exact outbound candidate",
      retryable: true,
    });
  });

  it("never treats a tapback row as the intended text send", async () => {
    const client = createClient({
      messages: [
        historyRow({
          guid: "TAPBACK-GUID",
          text: "hello",
          is_reaction: true,
          is_tapback: true,
          associated_message_guid: "TARGET-GUID",
        }),
      ],
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage history contains no exact outbound candidate",
      retryable: true,
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { sendState: "pending", retryable: true },
    { sendState: "failed", retryable: false },
  ])(
    "does not claim a history row whose send status is $sendState",
    async ({ sendState, retryable }) => {
      const client = createClient({
        sendStatus: {
          ok: true,
          guid: "MSG-GUID-1",
          send_state: sendState,
        },
      });

      await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
        status: "unresolved",
        error: `iMessage send status is not confirmed: ${sendState}`,
        retryable,
      });
    },
  );

  it("does not claim a send status response for a different message GUID", async () => {
    const client = createClient({
      sendStatus: {
        ok: true,
        guid: "OTHER-GUID",
        send_state: "delivered",
      },
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error: "iMessage send status is not confirmed: delivered",
      retryable: false,
    });
  });

  it("matches the final wire text after delivery-only directive stripping", async () => {
    const client = createClient({
      messages: [historyRow({ text: "hello world" })],
    });

    await expect(
      reconcileIMessageUnknownSend(
        createContext({ payloads: [{ text: "hello [[reply_to_current]] world" }] }),
        { client },
      ),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("passes the account-scoped remote cliPath to its owned client and stops it", async () => {
    const client = createClient();
    const createClientMock = vi.fn(async () => client);

    await expect(
      reconcileIMessageUnknownSend(createContext(), { createClient: createClientMock }),
    ).resolves.toMatchObject({ status: "sent" });

    expect(createClientMock).toHaveBeenCalledWith({
      cliPath: "/opt/openclaw/bin/remote-imsg",
      dbPath: undefined,
    });
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("stops an owned remote client after an RPC failure", async () => {
    const client = createClient({ historyError: new Error("rpc unavailable") });
    const createClientMock = vi.fn(async () => client);

    await expect(
      reconcileIMessageUnknownSend(createContext(), { createClient: createClientMock }),
    ).resolves.toMatchObject({ status: "unresolved" });

    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("does not discard proven delivery when owned-client cleanup fails", async () => {
    const client = createClient({ stopError: new Error("stop failed") });
    const createClientMock = vi.fn(async () => client);

    await expect(
      reconcileIMessageUnknownSend(createContext(), { createClient: createClientMock }),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "p:0/MSG-GUID-1",
    });

    expect(client.stop).toHaveBeenCalledOnce();
  });

  it("converts RPC failures into retryable unresolved outcomes", async () => {
    const client = createClient({ historyError: new Error("rpc unavailable") });

    const result = await reconcileIMessageUnknownSend(createContext({ retryCount: 2 }), {
      client,
    });

    expect(result).toEqual({
      status: "unresolved",
      error: "iMessage delivery reconciliation failed: Error: rpc unavailable",
      retryable: false,
    });
  });

  it("does not retry when the remote imsg lacks messages.history", async () => {
    const client = createClient({
      historyError: new Error("Method not found: code=-32601 messages.history"),
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error:
        "iMessage delivery reconciliation failed: Error: Method not found: code=-32601 messages.history",
      retryable: false,
    });
  });

  it("does not retry when the remote imsg lacks message.send_status", async () => {
    const client = createClient({
      sendStatusError: new Error("Method not found: code=-32601 message.send_status"),
    });

    await expect(reconcileIMessageUnknownSend(createContext(), { client })).resolves.toEqual({
      status: "unresolved",
      error:
        "iMessage delivery reconciliation failed: Error: Method not found: code=-32601 message.send_status",
      retryable: false,
    });
  });

  it("rejects non-text durable shapes before opening an RPC client", async () => {
    const createClientMock = vi.fn();

    const result = await reconcileIMessageUnknownSend(
      createContext({
        renderedBatchPlan: {
          payloadCount: 1,
          textCount: 1,
          mediaCount: 1,
          voiceCount: 0,
          presentationCount: 0,
          interactiveCount: 0,
          channelDataCount: 0,
          items: [{ index: 0, kinds: ["text", "media"], text: "hello", mediaUrls: ["a.png"] }],
        },
      }),
      { createClient: createClientMock },
    );

    expect(result).toEqual({
      status: "unresolved",
      error:
        "iMessage reconciliation requires exactly one non-empty, unformatted, unchunked text send",
      retryable: false,
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("rejects legacy multi-payload rows without a rendered batch plan", async () => {
    const createClientMock = vi.fn();

    const result = await reconcileIMessageUnknownSend(
      createContext({
        payloads: [{ text: "hello" }, { text: "second effect" }],
        renderedBatchPlan: undefined,
      }),
      { createClient: createClientMock },
    );

    expect(result).toEqual({
      status: "unresolved",
      error:
        "iMessage reconciliation requires exactly one non-empty, unformatted, unchunked text send",
      retryable: false,
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("does not claim text that core would split into multiple platform sends", async () => {
    const createClientMock = vi.fn();

    const result = await reconcileIMessageUnknownSend(
      createContext({
        cfg: {
          channels: {
            imessage: {
              cliPath: "/opt/openclaw/bin/remote-imsg",
              textChunkLimit: 5,
            },
          },
        } as OpenClawConfig,
        payloads: [{ text: "hello world" }],
      }),
      { createClient: createClientMock },
    );

    expect(result).toEqual({
      status: "unresolved",
      error:
        "iMessage reconciliation requires exactly one non-empty, unformatted, unchunked text send",
      retryable: false,
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("does not claim formatted text that history cannot fully prove", async () => {
    const createClientMock = vi.fn();

    const result = await reconcileIMessageUnknownSend(
      createContext({ payloads: [{ text: "**hello**" }] }),
      { createClient: createClientMock },
    );

    expect(result).toEqual({
      status: "unresolved",
      error:
        "iMessage reconciliation requires exactly one non-empty, unformatted, unchunked text send",
      retryable: false,
    });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
