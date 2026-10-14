import type { MessageMetadata } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import type { SlackPostMessagePayload } from "./post-message-payload.js";
import { reconcileSlackUnknownSend, sendMessageSlack } from "./send.js";

const clients = vi.hoisted(() => ({
  createSlackReadClient: vi.fn(),
  getSlackWriteClient: vi.fn(),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  ...clients,
}));

type Post = (request: SlackPostMessagePayload) => Promise<Record<string, unknown>>;
type Lookup = (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
type TestClient = WebClient & {
  chat: { postMessage: ReturnType<typeof vi.fn<Post>> };
  conversations: {
    history: ReturnType<typeof vi.fn<Lookup>>;
    open: ReturnType<typeof vi.fn<Lookup>>;
    replies: ReturnType<typeof vi.fn<Lookup>>;
  };
};
const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
const tokenCfg = { channels: { slack: { botToken: "xoxb-write", userToken: "xoxp-read" } } };
const ts = "1782584647.000002";
function createClient(): TestClient {
  return {
    chat: {
      postMessage: vi.fn<Post>(async () => ({ ok: true, channel: "C123", ts, message: {} })),
    },
    conversations: {
      history: vi.fn<Lookup>(async () => ({ messages: [] })),
      open: vi.fn<Lookup>(async () => ({ channel: { id: "D123" } })),
      replies: vi.fn<Lookup>(async () => ({ messages: [] })),
    },
  } as unknown as TestClient;
}
function context(
  overrides: Partial<ChannelMessageUnknownSendContext> = {},
): ChannelMessageUnknownSendContext {
  return {
    cfg,
    queueId: "queue-1",
    channel: "slack",
    to: "channel:C123",
    enqueuedAt: 1_782_584_644_000,
    retryCount: 0,
    platformSendStartedAt: 1_782_584_645_000,
    payloads: [{ text: "final answer" }],
    ...overrides,
  };
}
function reconcile(client: TestClient, overrides: Partial<ChannelMessageUnknownSendContext> = {}) {
  clients.createSlackReadClient.mockReturnValue(client);
  clients.getSlackWriteClient.mockReturnValue(client);
  return reconcileSlackUnknownSend(context(overrides));
}
async function marker(
  client: TestClient,
  options: Partial<Parameters<typeof sendMessageSlack>[2]> = {},
  to = "channel:C123",
) {
  await sendMessageSlack(to, "final answer", {
    cfg,
    client,
    deliveryQueueId: "queue-1",
    ...options,
  });
  return client.chat.postMessage.mock.calls[0]![0].metadata!;
}
beforeEach(() => {
  clients.createSlackReadClient.mockReset();
  clients.getSlackWriteClient.mockReset();
});

describe("Slack durable reconciliation", () => {
  it("uses workspace-scoped read and write clients for qualified reconciliation", async () => {
    const reader = createClient();
    const writer = createClient();
    clients.getSlackWriteClient.mockReturnValue(reader);
    const metadata = await marker(reader, {}, "team:T123:channel:C123");
    reader.conversations.history.mockResolvedValueOnce({ messages: [{ ts, metadata }] });
    clients.createSlackReadClient.mockReturnValue(reader);
    clients.getSlackWriteClient.mockReturnValue(writer);
    await expect(
      reconcileSlackUnknownSend(context({ cfg: tokenCfg, to: "team:T123:channel:C123" })),
    ).resolves.toMatchObject({ status: "sent", messageId: ts });
    expect(clients.createSlackReadClient).toHaveBeenCalledWith("xoxp-read", { teamId: "T123" });
    expect(clients.getSlackWriteClient).toHaveBeenCalledWith("xoxb-write", { teamId: "T123" });
    expect(reader.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123" }),
    );
    expect(writer.conversations.history).not.toHaveBeenCalled();
  });

  it("returns a terminal unresolved result for bare Enterprise reconciliation", async () => {
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(reconcileSlackUnknownSend(context())).resolves.toEqual({
        status: "unresolved",
        error: expect.stringContaining("unsupported_enterprise_slack_delivery"),
        retryable: false,
      });
      expect(clients.createSlackReadClient).not.toHaveBeenCalled();
    } finally {
      installation.release();
    }
  });

  it("reconciles every ordered native-data fallback batch as one durable part set", async () => {
    const client = createClient();
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }),
    );
    const ids = [1, 2, 3, 4].map((index) => `1782584647.00000${index}`);
    for (const id of ids) {
      client.chat.postMessage.mockResolvedValueOnce({ ok: true, channel: "C123", ts: id });
    }
    const caption = "c".repeat(9_000);
    const table = {
      type: "data_table",
      caption,
      rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
    };
    const onDeliveryResult = vi.fn();
    const sent = await sendMessageSlack("channel:C123", "Pipeline", {
      cfg,
      client,
      deliveryQueueId: "queue-1",
      onDeliveryResult,
      metadata: { event_type: "assistant_thread_context", event_payload: { team_id: "T123" } },
      blocks: [
        ...Array.from({ length: 48 }, () => ({ type: "divider" })),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "approve",
              text: { type: "plain_text", text: "Approve" },
              value: "yes",
            },
          ],
        },
        table,
      ],
    });
    const requests = client.chat.postMessage.mock.calls.map(([request]) => request);
    expect(requests[0]?.text).toBe(`Pipeline\n\nApprove\n\n${caption} (table)\nAccount\nAcme`);
    expect(requests[0]?.metadata?.event_payload.openclaw_delivery_part_count).toBe(1);
    const fallback = requests.slice(1);
    expect(fallback).toHaveLength(4);
    expect(
      fallback.every(
        (post) => (post.blocks?.length ?? 0) <= 50 && (post.text?.length ?? 0) <= 4_000,
      ),
    ).toBe(true);
    expect(fallback.every((post) => post.mrkdwn === false)).toBe(true);
    expect(fallback.map((post) => post.text).join("\n")).not.toContain("yes");
    const fallbackBlocks = fallback.flatMap((post) => post.blocks ?? []);
    expect(fallbackBlocks.filter((block) => block.type === "actions")).toHaveLength(1);
    const text = fallbackBlocks.flatMap((block) =>
      "text" in block && typeof block.text === "object" && block.text && "text" in block.text
        ? [block.text.text]
        : [],
    );
    expect(text.join("")).toBe(`Pipeline${caption} (table)\nAccount\nAcme`);
    const metadata = fallback.map((request) => request.metadata!);
    expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_index)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_count)).toEqual([
      4, 4, 4, 4,
    ]);
    expect(metadata[0]?.event_payload).toMatchObject({ team_id: "T123" });
    for (const part of metadata.slice(1)) {
      expect(part.event_payload).not.toHaveProperty("team_id");
    }
    expect(new Set(metadata.map((part) => part.event_payload.openclaw_delivery_id)).size).toBe(1);
    expect(sent.receipt.platformMessageIds).toEqual(ids);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual(ids);
    client.conversations.history.mockResolvedValueOnce({
      messages: metadata.map((part, index) => ({ ts: ids[index], metadata: part })).toReversed(),
    });
    await expect(reconcile(client)).resolves.toMatchObject({
      status: "sent",
      receipt: { platformMessageIds: ids },
    });
  });

  it("opens a durable user-identity DM before marking platform dispatch", async () => {
    const client = createClient();
    const order: string[] = [];
    client.conversations.open.mockImplementationOnce(async () => {
      order.push("open");
      return { channel: { id: "D123" } };
    });
    client.chat.postMessage.mockImplementationOnce(async () => {
      order.push("post");
      return { ok: true, channel: "D123", ts };
    });
    clients.getSlackWriteClient.mockReturnValue(client);
    await sendMessageSlack("user:U123", "final answer", {
      cfg: { channels: { slack: { postAs: "user", userToken: "test-user-token" } } },
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
    });
    expect(clients.getSlackWriteClient).toHaveBeenCalledWith("test-user-token");
    expect(order).toEqual(["open", "dispatch", "post"]);
  });

  it.each(["missing_scope"])("checks the write token after read-token %s", async (failure) => {
    const reader = createClient();
    const writer = createClient();
    const metadata = await marker(writer, {}, "user:U123");
    if (failure === "missing_scope") {
      reader.conversations.history.mockRejectedValueOnce(new Error(failure));
    }
    writer.conversations.history.mockResolvedValueOnce({ messages: [{ ts, metadata }] });
    clients.createSlackReadClient.mockReturnValue(reader);
    clients.getSlackWriteClient.mockReturnValue(writer);
    await expect(
      reconcileSlackUnknownSend(context({ cfg: tokenCfg, to: "U123" })),
    ).resolves.toMatchObject({ status: "sent" });
    expect(writer.conversations.open).toHaveBeenCalledWith({ users: "U123" });
    expect(reader.conversations.history).toHaveBeenCalledOnce();
    expect(writer.conversations.history).toHaveBeenCalledOnce();
  });

  it("does not confuse an identical later message without the durable id", async () => {
    const client = createClient();
    client.conversations.history.mockResolvedValue({ messages: [{ ts, text: "final answer" }] });
    await expect(reconcile(client)).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains no exact durable delivery marker",
      retryable: true,
    });
    await expect(reconcile(client, { retryCount: 2 })).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains no exact durable delivery marker",
      retryable: false,
    });
  });

  it("reconciles the persisted exact thread reply", async () => {
    const client = createClient();
    const thread = "1782584644.377229";
    const metadata = await marker(client, { threadTs: thread });
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts, thread_ts: thread, metadata }],
    });
    await expect(
      reconcile(client, {
        threadId: "1782584644.111111",
        payloads: [{ text: "final answer", replyToId: "1782584644.222222" }],
        effectiveReplyToId: thread,
      }),
    ).resolves.toMatchObject({ status: "sent", receipt: { threadId: thread } });
    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", ts: thread, include_all_metadata: true }),
    );
  });

  it.each([
    { replyToId: "1782584644.377229", replyToMode: "off" as const },
    { replyToId: "1782584644.377229", payloads: [{ text: "final answer", replyToId: "" }] },
  ])("uses channel history for a cleared reply target: %j", async (overrides) => {
    const client = createClient();
    const metadata = await marker(client);
    client.conversations.history.mockResolvedValueOnce({ messages: [{ ts, metadata }] });
    await expect(reconcile(client, overrides)).resolves.toMatchObject({ status: "sent" });
    expect(client.conversations.history).toHaveBeenCalledOnce();
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("paginates past malformed signatures to find the exact durable id", async () => {
    const client = createClient();
    const metadata = await marker(client);
    expect(JSON.stringify(metadata)).not.toContain("queue-1");
    const signature = metadata.event_payload.openclaw_delivery_signature as string;
    const tampered = {
      ...metadata,
      event_payload: {
        ...metadata.event_payload,
        openclaw_delivery_signature: "é".repeat(signature.length),
      },
    };
    client.conversations.history
      .mockResolvedValueOnce({
        messages: [{ ts: "1782584648.000003", metadata: tampered }],
        has_more: true,
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({ messages: [{ ts, metadata }] });
    await expect(reconcile(client)).resolves.toMatchObject({ status: "sent", messageId: ts });
    expect(client.conversations.history).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      oldest: "1782584315.000000",
      latest: "1782584945.000000",
      include_all_metadata: true,
      limit: 100,
      cursor: "cursor-2",
    });
  });

  it("reconciles complete indexed text parts and rejects forged indexes", async () => {
    const client = createClient();
    let index = 0;
    client.chat.postMessage.mockImplementation(async () => ({
      ok: true,
      channel: "C123",
      ts: `1782584647.00000${++index}`,
    }));
    await sendMessageSlack("channel:C123", "final answer", {
      cfg,
      client,
      textLimit: 5,
      deliveryQueueId: "queue-1",
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    const metadata = client.chat.postMessage.mock.calls.map(([request]) => request.metadata!);
    expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_index)).toEqual([
      0, 1, 2,
    ]);
    expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_count)).toEqual([
      3, 3, 3,
    ]);
    expect(new Set(metadata.map((part) => part.event_payload.openclaw_delivery_id)).size).toBe(1);
    expect(
      new Set(metadata.map((part) => part.event_payload.openclaw_delivery_signature)).size,
    ).toBe(3);
    const ids = [1, 2, 3].map((part) => `1782584647.00000${part}`);
    client.conversations.history.mockResolvedValueOnce({
      messages: metadata.map((part, i) => ({ ts: ids[i], metadata: part })),
    });
    await expect(reconcile(client)).resolves.toMatchObject({
      status: "sent",
      receipt: { platformMessageIds: ids },
    });
    const first = metadata[0]!;
    const forged: MessageMetadata[] = [first];
    for (const part of [1, 2]) {
      forged.push({
        ...first,
        event_payload: { ...first.event_payload, openclaw_delivery_part_index: part },
      });
    }
    client.conversations.history.mockResolvedValueOnce({
      messages: forged.map((part, i) => ({ ts: ids[i], metadata: part })),
    });
    await expect(reconcile(client)).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains an incomplete durable delivery marker set",
      retryable: true,
    });
  });
});
