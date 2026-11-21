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
type SendOptions = Partial<Parameters<typeof sendMessageSlack>[2]> & { to?: string; text?: string };
const cfg = { channels: { slack: { botToken: "xoxb-test" } } };
const tokenCfg = { channels: { slack: { botToken: "xoxb-write", userToken: "xoxp-read" } } };
const ts = "1782584647.000002";
const postResult = (id = ts, channel = "C123") => ({ ok: true, channel, ts: id });
const partIds = (count: number) =>
  Array.from({ length: count }, (_, i) => `1782584647.00000${i + 1}`);
const tamper = (metadata: MessageMetadata, patch: MessageMetadata["event_payload"]) => ({
  ...metadata,
  event_payload: { ...metadata.event_payload, ...patch },
});
function createClient() {
  const stub = {
    chat: {
      postMessage: vi.fn<Post>(async () => postResult()),
    },
    conversations: {
      history: vi.fn<Lookup>(async () => ({ messages: [] })),
      open: vi.fn<Lookup>(async () => ({ channel: { id: "D123" } })),
      replies: vi.fn<Lookup>(async () => ({ messages: [] })),
    },
  };
  return stub as typeof stub & WebClient;
}
function expectParts(metadata: MessageMetadata[], indexes: number[]) {
  expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_index)).toEqual(indexes);
  expect(metadata.map((part) => part.event_payload.openclaw_delivery_part_count)).toEqual(
    indexes.map(() => indexes.length),
  );
  expect(new Set(metadata.map((part) => part.event_payload.openclaw_delivery_id)).size).toBe(1);
}
describe("Slack durable reconciliation", () => {
  let client: ReturnType<typeof createClient>;
  function reconcile(overrides: Partial<ChannelMessageUnknownSendContext> = {}) {
    return reconcileSlackUnknownSend({
      cfg,
      queueId: "queue-1",
      channel: "slack",
      to: "channel:C123",
      enqueuedAt: 1_782_584_644_000,
      retryCount: 0,
      platformSendStartedAt: 1_782_584_645_000,
      payloads: [{ text: "final answer" }],
      ...overrides,
    });
  }
  function send({ to = "channel:C123", text = "final answer", ...options }: SendOptions = {}) {
    return sendMessageSlack(to, text, { cfg, client, deliveryQueueId: "queue-1", ...options });
  }
  async function marker(options: SendOptions = {}) {
    await send(options);
    return client.chat.postMessage.mock.calls[0]![0].metadata!;
  }
  function history(metadata: MessageMetadata) {
    return { messages: [{ ts, metadata }] };
  }
  function unresolved(error: string, retryable = true) {
    return { status: "unresolved", error, retryable };
  }
  beforeEach(() => {
    client = createClient();
    clients.createSlackReadClient.mockReset().mockReturnValue(client);
    clients.getSlackWriteClient.mockReset().mockReturnValue(client);
  });
  it("uses workspace-scoped read and write clients for qualified reconciliation", async () => {
    const writer = createClient();
    const metadata = await marker({ to: "team:T123:channel:C123" });
    client.conversations.history.mockResolvedValueOnce(history(metadata));
    clients.getSlackWriteClient.mockReturnValue(writer);
    await expect(reconcile({ cfg: tokenCfg, to: "team:T123:channel:C123" })).resolves.toMatchObject(
      { status: "sent", messageId: ts },
    );
    expect(clients.createSlackReadClient).toHaveBeenCalledWith("xoxp-read", { teamId: "T123" });
    expect(clients.getSlackWriteClient).toHaveBeenCalledWith("xoxb-write", { teamId: "T123" });
    expect(client.conversations.history).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123" }),
    );
    expect(writer.conversations.history).not.toHaveBeenCalled();
  });

  it("returns a terminal unresolved result for bare Enterprise reconciliation", async () => {
    const installation = registerSlackInstallationState("default", "enterprise");
    try {
      await expect(reconcile()).resolves.toEqual({
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
    client.chat.postMessage.mockRejectedValueOnce(
      Object.assign(new Error("invalid_blocks"), { data: { error: "invalid_blocks" } }),
    );
    const ids = partIds(4);
    for (const id of ids) {
      client.chat.postMessage.mockResolvedValueOnce(postResult(id));
    }
    const caption = "c".repeat(9_000);
    const onDeliveryResult = vi.fn();
    const sent = await send({
      text: "Pipeline",
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
        {
          type: "data_table",
          caption,
          rows: ["Account", "Acme"].map((text) => [{ type: "raw_text", text }]),
        },
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
    expectParts(metadata, [0, 1, 2, 3]);
    expect(metadata[0]?.event_payload).toMatchObject({ team_id: "T123" });
    for (const part of metadata.slice(1)) {
      expect(part.event_payload).not.toHaveProperty("team_id");
    }
    expect(sent.receipt.platformMessageIds).toEqual(ids);
    expect(onDeliveryResult.mock.calls.map(([delivery]) => delivery.messageId)).toEqual(ids);
    client.conversations.history.mockResolvedValueOnce({
      messages: metadata.map((part, index) => ({ ts: ids[index], metadata: part })).toReversed(),
    });
    await expect(reconcile()).resolves.toMatchObject({
      status: "sent",
      receipt: { platformMessageIds: ids },
    });
  });

  it("opens a durable user-identity DM before marking platform dispatch", async () => {
    const order: string[] = [];
    client.conversations.open.mockImplementationOnce(async () => {
      order.push("open");
      return { channel: { id: "D123" } };
    });
    client.chat.postMessage.mockImplementationOnce(async () => {
      order.push("post");
      return postResult(ts, "D123");
    });
    await send({
      to: "user:U123",
      client: undefined,
      cfg: { channels: { slack: { postAs: "user", userToken: "test-user-token" } } },
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
    });
    expect(clients.getSlackWriteClient).toHaveBeenCalledWith("test-user-token");
    expect(order).toEqual(["open", "dispatch", "post"]);
  });

  it("checks the write token after read-token missing_scope", async () => {
    const reader = createClient();
    const metadata = await marker({ to: "user:U123" });
    reader.conversations.history.mockRejectedValueOnce(new Error("missing_scope"));
    client.conversations.history.mockResolvedValueOnce(history(metadata));
    clients.createSlackReadClient.mockReturnValue(reader);
    await expect(reconcile({ cfg: tokenCfg, to: "U123" })).resolves.toMatchObject({
      status: "sent",
    });
    expect(client.conversations.open).toHaveBeenCalledWith({ users: "U123" });
    expect(reader.conversations.history).toHaveBeenCalledOnce();
    expect(client.conversations.history).toHaveBeenCalledOnce();
  });

  it("does not confuse an identical later message without the durable id", async () => {
    client.conversations.history.mockResolvedValue({ messages: [{ ts, text: "final answer" }] });
    const error = "Slack history contains no exact durable delivery marker";
    await expect(reconcile()).resolves.toEqual(unresolved(error));
    await expect(reconcile({ retryCount: 2 })).resolves.toEqual(unresolved(error, false));
  });

  it("reconciles the persisted exact thread reply", async () => {
    const thread = "1782584644.377229";
    const metadata = await marker({ threadTs: thread });
    client.conversations.replies.mockResolvedValueOnce({
      messages: [{ ts, metadata, thread_ts: thread }],
    });
    await expect(
      reconcile({
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
    const metadata = await marker();
    client.conversations.history.mockResolvedValueOnce(history(metadata));
    await expect(reconcile(overrides)).resolves.toMatchObject({ status: "sent" });
    expect(client.conversations.history).toHaveBeenCalledOnce();
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("paginates past malformed signatures to find the exact durable id", async () => {
    const metadata = await marker();
    expect(JSON.stringify(metadata)).not.toContain("queue-1");
    const signature = metadata.event_payload.openclaw_delivery_signature as string;
    const tampered = tamper(metadata, {
      openclaw_delivery_signature: "é".repeat(signature.length),
    });
    client.conversations.history
      .mockResolvedValueOnce({
        messages: [{ ts: "1782584648.000003", metadata: tampered }],
        has_more: true,
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce(history(metadata));
    await expect(reconcile()).resolves.toMatchObject({ status: "sent", messageId: ts });
    expect(client.conversations.history).toHaveBeenNthCalledWith(2, {
      channel: "C123",
      oldest: "1782584315.000000",
      latest: "1782584945.000000",
      include_all_metadata: true,
      limit: 100,
      cursor: "cursor-2",
    });
  });

  it("signs indexed text parts and rejects forged indexes", async () => {
    let index = 0;
    const ids = partIds(3);
    client.chat.postMessage.mockImplementation(async () => postResult(ids[index++]!));
    await marker({ textLimit: 5 });
    const metadata = client.chat.postMessage.mock.calls.map(([request]) => request.metadata!);
    expectParts(metadata, [0, 1, 2]);
    expect(
      new Set(metadata.map((part) => part.event_payload.openclaw_delivery_signature)).size,
    ).toBe(3);
    const first = metadata[0]!;
    const forged = [
      first,
      ...[1, 2].map((part) => tamper(first, { openclaw_delivery_part_index: part })),
    ];
    client.conversations.history.mockResolvedValueOnce({
      messages: forged.map((part, i) => ({ ts: ids[i], metadata: part })),
    });
    await expect(reconcile()).resolves.toEqual(
      unresolved("Slack history contains an incomplete durable delivery marker set"),
    );
  });
});
