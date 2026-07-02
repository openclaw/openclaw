// Slack tests cover delivery-queue unknown-send reconciliation.
import type { WebClient } from "@slack/web-api";
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { reconcileSlackUnknownSend } from "./send.js";

type SlackReconcileTestClient = WebClient & {
  conversations: {
    history: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    replies: ReturnType<typeof vi.fn>;
  };
};

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

function createSlackReconcileTestClient(): SlackReconcileTestClient {
  return {
    conversations: {
      history: vi.fn(async () => ({ messages: [] })),
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
  } as unknown as SlackReconcileTestClient;
}

function createUnknownSendContext(
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

describe("reconcileSlackUnknownSend", () => {
  it("marks a matching thread reply as already sent", async () => {
    const client = createSlackReconcileTestClient();
    client.conversations.replies.mockResolvedValueOnce({
      messages: [
        { ts: "1782584646.000001", text: "not it" },
        {
          ts: "1782584647.000002",
          text: "final answer",
          thread_ts: "1782584644.377229",
        },
      ],
    });

    const result = await reconcileSlackUnknownSend(
      createUnknownSendContext({
        threadId: "1782584644.377229",
      }),
      { client, now: 1_782_584_648_000 },
    );

    expect(client.conversations.replies).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1782584644.377229",
      oldest: "1782584615.000000",
      latest: "1782584658.000000",
      limit: 50,
    });
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.messageId).toBe("1782584647.000002");
      expect(result.receipt.platformMessageIds).toEqual(["1782584647.000002"]);
      expect(result.receipt.threadId).toBe("1782584644.377229");
    }
  });

  it("replays only when searchable Slack history lacks the expected text", async () => {
    const client = createSlackReconcileTestClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", text: "different answer" }],
    });

    const result = await reconcileSlackUnknownSend(createUnknownSendContext(), {
      client,
      now: 1_782_584_648_000,
    });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C123",
      oldest: "1782584615.000000",
      latest: "1782584658.000000",
      limit: 50,
    });
    expect(result).toEqual({ status: "not_sent" });
  });

  it("does not guess when the queued payload is not one short text message", async () => {
    const client = createSlackReconcileTestClient();

    const result = await reconcileSlackUnknownSend(
      createUnknownSendContext({
        payloads: [{ text: "one" }, { text: "two" }],
      }),
      { client },
    );

    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "unresolved",
      error: "Slack unknown-send reconciliation requires one short text payload",
      retryable: true,
    });
  });

  it("resolves user targets to DM channels before checking history", async () => {
    const client = createSlackReconcileTestClient();
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", text: "final answer" }],
    });

    const result = await reconcileSlackUnknownSend(
      createUnknownSendContext({
        to: "user:U123",
      }),
      { client, now: 1_782_584_648_000 },
    );

    expect(client.conversations.open).toHaveBeenCalledWith({ users: "U123" });
    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "D123",
      oldest: "1782584615.000000",
      latest: "1782584658.000000",
      limit: 50,
    });
    expect(result.status).toBe("sent");
  });
});
