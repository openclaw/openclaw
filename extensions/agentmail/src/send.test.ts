import type { AgentMailClient } from "agentmail";
import { describe, expect, it, vi } from "vitest";
import { AgentMailMediaPolicyError } from "./media.js";
import {
  normalizeAgentMailTarget,
  parseAgentMailMessageTarget,
  reconcileAgentMailUnknownSend,
  sendAgentMailReply,
} from "./send.js";

type ReplyArgs = Parameters<AgentMailClient["inboxes"]["messages"]["reply"]>;

const reply = vi.fn(async (..._args: ReplyArgs) => ({
  messageId: "reply_1",
  threadId: "thread_1",
}));
const get = vi.fn(async (_inboxId: string, messageId: string) => ({
  inboxId: "inbox_1",
  threadId: "thread_1",
  messageId,
  labels: ["received"],
  timestamp: new Date(0),
  from: "Allowed Sender <sender@example.com>",
  replyTo: ["attacker@example.net"],
  to: ["inbox@example.com"],
  size: 1,
  updatedAt: new Date(0),
  createdAt: new Date(0),
}));
const client = () => ({ inboxes: { messages: { get, reply } } }) as never;
const loadAgentMailOutboundAttachments = vi.hoisted(() =>
  vi.fn(async () => [
    {
      filename: "proof.txt",
      contentType: "text/plain",
      contentDisposition: "attachment",
      content: "cHJvb2Y=",
    },
  ]),
);

vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  loadAgentMailOutboundAttachments,
}));

describe("AgentMail reply-only outbound", () => {
  it("accepts only message targets", () => {
    expect(normalizeAgentMailTarget("message:msg_123")).toBe("message:msg_123");
    expect(normalizeAgentMailTarget("message:<rfc-message@example.com>")).toBe(
      "message:<rfc-message@example.com>",
    );
    expect(normalizeAgentMailTarget("message:bad id")).toBeNull();
    expect(normalizeAgentMailTarget("thread:thread_1")).toBeNull();
    expect(normalizeAgentMailTarget("person@example.com")).toBeNull();
    expect(() => parseAgentMailMessageTarget("person@example.com")).toThrow("message:<messageId>");
  });

  it("replies once to the authorized From even when Reply-To names another recipient", async () => {
    reply.mockClear();
    get.mockClear();
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    await sendAgentMailReply(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              allowFrom: ["sender@example.com"],
              mediaMaxMb: 20,
            },
          },
        },
        to: "message:msg_1",
        text: "Hello",
        payload: { text: "Hello", mediaUrls: ["file:///proof.txt"] },
        replyToId: "msg_1",
        replyToIdSource: "implicit",
        deliveryQueueId: "queue_1",
        onPlatformSendDispatch,
      },
      { client: client() },
    );

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    const [inboxId, messageId, request, requestOptions] = reply.mock.calls[0]!;
    expect(inboxId).toBe("inbox_1");
    expect(messageId).toBe("msg_1");
    expect(request).toEqual({
      text: "Hello",
      attachments: [expect.objectContaining({ filename: "proof.txt" })],
      to: ["sender@example.com"],
      replyAll: false,
    });
    expect(request).not.toHaveProperty("cc");
    expect(request).not.toHaveProperty("bcc");
    expect(request).not.toHaveProperty("replyTo");
    expect(requestOptions?.idempotencyKey).toMatch(/^openclaw-agentmail-[a-f0-9]{64}$/u);
    expect(get).toHaveBeenCalledWith("inbox_1", "msg_1");
  });

  it("rejects a different target than the active turn's triggering message", async () => {
    await expect(
      sendAgentMailReply(
        {
          cfg: {
            channels: {
              agentmail: {
                apiKey: "key",
                inboxId: "inbox_1",
                allowFrom: ["sender@example.com"],
              },
            },
          },
          to: "message:msg_b",
          text: "Wrong recipient",
          replyToId: "msg_a",
          replyToIdSource: "implicit",
          deliveryQueueId: "queue_1",
        },
        { client: client() },
      ),
    ).rejects.toThrow("triggering message");
  });

  it("rejects a reply when the authoritative From is not allowlisted", async () => {
    reply.mockClear();
    const deniedGet = vi.fn(async (_inboxId: string, messageId: string) => ({
      ...(await get("inbox_1", messageId)),
      from: "denied@example.net",
      replyTo: ["sender@example.com"],
    }));
    await expect(
      sendAgentMailReply(
        {
          cfg: {
            channels: {
              agentmail: {
                apiKey: "key",
                inboxId: "inbox_1",
                allowFrom: ["sender@example.com"],
              },
            },
          },
          to: "message:msg_1",
          text: "Hello",
          replyToId: "msg_1",
          replyToIdSource: "implicit",
          deliveryQueueId: "queue_1",
        },
        { client: { inboxes: { messages: { get: deniedGet, reply } } } as never },
      ),
    ).rejects.toThrow("recipient is not an authorized triggering sender");
    expect(reply).not.toHaveBeenCalled();
  });

  it("rejects explicit and proactive message targets", async () => {
    const base = {
      cfg: {
        channels: {
          agentmail: {
            apiKey: "key",
            inboxId: "inbox_1",
            allowFrom: ["sender@example.com"],
          },
        },
      },
      to: "message:msg_1",
      text: "Not an automatic source reply",
      deliveryQueueId: "queue_1",
    };
    await expect(
      sendAgentMailReply(
        { ...base, replyToId: "msg_1", replyToIdSource: "explicit" },
        { client: client() },
      ),
    ).rejects.toThrow("triggering message");
    await expect(
      sendAgentMailReply(base, {
        client: client(),
      }),
    ).rejects.toThrow("triggering message");
  });

  it("refuses delivery without a durable queue id", async () => {
    await expect(
      sendAgentMailReply(
        {
          cfg: {
            channels: {
              agentmail: {
                apiKey: "key",
                inboxId: "inbox_1",
                allowFrom: ["sender@example.com"],
              },
            },
          },
          to: "message:msg_1",
          text: "Hello",
          replyToId: "msg_1",
          replyToIdSource: "implicit",
        },
        { client: client() },
      ),
    ).rejects.toThrow("durable OpenClaw delivery queue ID");
  });

  it("reconciles an unknown send with the same queue-derived idempotency key", async () => {
    reply.mockClear();
    loadAgentMailOutboundAttachments.mockClear();
    const now = 10_000;
    const mediaReadFile = vi.fn(async () => Buffer.from("proof"));
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              allowFrom: ["sender@example.com"],
            },
          },
        },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_1",
        accountId: "default",
        enqueuedAt: now - 1_000,
        retryCount: 1,
        effectiveReplyToId: "msg_1",
        payloads: [{ text: "Hello", mediaUrls: ["file:///proof.txt"] }],
        mediaAccess: { localRoots: ["/"] },
        mediaLocalRoots: ["/"],
        mediaReadFile,
      },
      { client: client(), now: () => now },
    );
    expect(result.status).toBe("sent");
    expect(loadAgentMailOutboundAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaAccess: { localRoots: ["/"] },
        mediaLocalRoots: ["/"],
        mediaReadFile,
      }),
    );
    expect(reply.mock.calls[0]?.[3]).toEqual({
      idempotencyKey: expect.stringMatching(/^openclaw-agentmail-[a-f0-9]{64}$/u),
    });
  });

  it("does not restore media removed by the persisted rendered plan", async () => {
    loadAgentMailOutboundAttachments.mockClear();
    const now = 10_000;
    await reconcileAgentMailUnknownSend(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              allowFrom: ["sender@example.com"],
            },
          },
        },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_1",
        accountId: "default",
        enqueuedAt: now - 1_000,
        retryCount: 1,
        effectiveReplyToId: "msg_1",
        payloads: [{ text: "Hello", mediaUrls: ["file:///filtered.txt"] }],
        renderedBatchPlan: {
          payloadCount: 1,
          textCount: 1,
          mediaCount: 0,
          voiceCount: 0,
          presentationCount: 0,
          interactiveCount: 0,
          channelDataCount: 0,
          items: [{ index: 0, kinds: ["text"], text: "Hello", mediaUrls: [] }],
        },
      },
      { client: client(), now: () => now },
    );

    expect(loadAgentMailOutboundAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrls: [] }),
    );
  });

  it("fails closed before AgentMail's idempotency key can expire", async () => {
    reply.mockClear();
    loadAgentMailOutboundAttachments.mockClear();
    const now = 24 * 60 * 60 * 1000;
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              allowFrom: ["sender@example.com"],
            },
          },
        },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_1",
        accountId: "default",
        enqueuedAt: 0,
        platformSendStartedAt: 60 * 60 * 1000,
        retryCount: 1,
        effectiveReplyToId: "msg_1",
        payloads: [{ text: "Hello" }],
      },
      { client: client(), now: () => now },
    );

    expect(result).toEqual({
      status: "unresolved",
      error: "AgentMail recovery is too close to the provider idempotency-key expiry",
      retryable: false,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(loadAgentMailOutboundAttachments).not.toHaveBeenCalled();
  });

  it("fails unknown-send recovery closed for deterministic media policy errors", async () => {
    reply.mockClear();
    loadAgentMailOutboundAttachments.mockRejectedValueOnce(
      new AgentMailMediaPolicyError(
        "AgentMail outbound attachments exceed the configured aggregate media limit",
      ),
    );
    const now = 10_000;

    await expect(
      reconcileAgentMailUnknownSend(
        {
          cfg: {
            channels: {
              agentmail: {
                apiKey: "key",
                inboxId: "inbox_1",
                allowFrom: ["sender@example.com"],
              },
            },
          },
          queueId: "queue_1",
          channel: "agentmail",
          to: "message:msg_1",
          accountId: "default",
          enqueuedAt: now - 1_000,
          retryCount: 1,
          effectiveReplyToId: "msg_1",
          payloads: [{ text: "Hello", mediaUrls: ["file:///oversized.bin"] }],
        },
        { client: client(), now: () => now },
      ),
    ).resolves.toEqual({
      status: "unresolved",
      error: "AgentMail outbound attachments exceed the configured aggregate media limit",
      retryable: false,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("refuses recovery when the persisted reply target differs", async () => {
    const now = 10_000;
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              allowFrom: ["sender@example.com"],
            },
          },
        },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_b",
        accountId: "default",
        enqueuedAt: now - 1_000,
        retryCount: 1,
        effectiveReplyToId: "msg_a",
        payloads: [{ text: "Hello" }],
      },
      { client: client(), now: () => now },
    );
    expect(result).toEqual({
      status: "unresolved",
      error: "AgentMail recovery target is not bound to its triggering message",
      retryable: false,
    });
  });
});
