import { AgentMailError, type AgentMail } from "agentmail";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAgentMailInboundEvent, resolveAgentMailMessageText } from "./inbound.js";
import { AgentMailMediaPolicyError } from "./media.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const loadAgentMailInboundAttachments = vi.hoisted(() => vi.fn());

vi.mock("./media.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media.js")>()),
  loadAgentMailInboundAttachments,
}));

const hookVal = "test-value";

const account: ResolvedAgentMailAccount = {
  accountId: "default",
  enabled: true,
  apiKey: "key",
  inboxId: "inbox_1",
  webhookSecret: hookVal,
  webhookPath: "/webhooks/agentmail",
  dmPolicy: "allowlist",
  allowFrom: ["sender@example.com"],
  mediaMaxBytes: 20 * 1024 * 1024,
};

const record: AgentMailIngressRecord = {
  accountId: "default",
  inboxId: "inbox_1",
  messageId: "message_1",
  transport: "webhook",
  receivedAt: 1,
};

function message(overrides: Partial<AgentMail.Message> = {}): AgentMail.Message {
  return {
    inboxId: "inbox_1",
    threadId: "thread_1",
    messageId: "message_1",
    labels: ["received"],
    timestamp: new Date("2026-07-15T00:00:00Z"),
    from: "Sender <sender@example.com>",
    to: ["inbox@example.com"],
    text: "hello",
    attachments: [],
    size: 5,
    updatedAt: new Date("2026-07-15T00:00:00Z"),
    createdAt: new Date("2026-07-15T00:00:00Z"),
    ...overrides,
  };
}

const attachmentPolicyCases: Array<{
  name: string;
  overrides: Partial<AgentMail.Message>;
  expectedBody: string;
}> = [
  {
    name: "preserves text and omits all attachments after a deterministic media rejection",
    overrides: {},
    expectedBody: "hello\n\n[Attachments omitted because they exceed the configured media limit]",
  },
  {
    name: "dispatches an omission notice when rejected attachments were the only content",
    overrides: {
      text: undefined,
      extractedText: undefined,
      html: undefined,
      extractedHtml: undefined,
      subject: undefined,
    },
    expectedBody: "[Attachments omitted because they exceed the configured media limit]",
  },
];

describe("AgentMail REST-authoritative inbound", () => {
  beforeEach(() => {
    loadAgentMailInboundAttachments.mockReset();
    loadAgentMailInboundAttachments.mockResolvedValue({ paths: [], types: [] });
  });

  it("uses HTML fallback from the hydrated message", () => {
    expect(
      resolveAgentMailMessageText(
        message({ text: undefined, extractedText: undefined, html: "<p>Hello <b>world</b></p>" }),
      ),
    ).toBe("Hello world");
  });

  it("prefers extracted reply content over the full quoted body", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          extractedText: "new reply",
          text: "new reply\n\nOn Tuesday, someone wrote:\nold quoted history",
          extractedHtml: "<p>new html reply</p>",
          html: "<p>full html history</p>",
        }),
      ),
    ).toBe("new reply");
  });

  it("prefers extracted HTML over a full plain-text body", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          extractedText: undefined,
          extractedHtml: "<p>new reply</p>",
          text: "new reply\n\nOn Tuesday, someone wrote:\nold quoted history",
          html: "<p>full html history</p>",
        }),
      ),
    ).toBe("new reply");
  });

  it("uses the hydrated subject when the message body is empty", () => {
    expect(
      resolveAgentMailMessageText(
        message({
          text: undefined,
          extractedText: undefined,
          html: undefined,
          extractedHtml: undefined,
          subject: "Subject-only request",
        }),
      ),
    ).toBe("Subject-only request");
  });

  it.each(attachmentPolicyCases)("$name", async ({ overrides, expectedBody }) => {
    loadAgentMailInboundAttachments.mockRejectedValueOnce(
      new AgentMailMediaPolicyError("attachments exceed the configured aggregate media limit"),
    );
    let context: Record<string, unknown> | undefined;
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        routing: {
          resolveAgentRoute: () => ({ agentId: "main" }),
          buildAgentSessionKey: () => "session-thread-1",
        },
        inbound: {
          buildContext: (value: Record<string, unknown>) => {
            context = value;
            return value;
          },
          run: async ({
            raw,
            adapter,
          }: {
            raw: AgentMail.Message;
            adapter: Record<string, Function>;
          }) => {
            const ingested = adapter.ingest!(raw);
            await adapter.resolveTurn!(ingested);
          },
        },
        session: {
          resolveStorePath: () => "/tmp/session.json",
          recordInboundSession: vi.fn(),
        },
        reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
      } as never,
      client: { inboxes: { messages: { get: vi.fn(async () => message(overrides)) } } } as never,
    });

    expect(context?.message).toEqual(
      expect.objectContaining({
        bodyForAgent: expectedBody,
      }),
    );
    expect(context?.extra).toEqual(expect.objectContaining({ MediaPaths: [], MediaTypes: [] }));
  });

  it("hydrates positionally, keys sessions by inbox and thread, and fixes the reply target", async () => {
    const get = vi.fn(async () => message());
    const resolveAgentRoute = vi.fn(() => ({ agentId: "main", sessionKey: "session-thread-1" }));
    const buildAgentSessionKey = vi.fn(() => "session-thread-1");
    const onTurnAdopted = vi.fn(async () => undefined);
    let turn: Record<string, unknown> | undefined;
    const channelRuntime = {
      routing: { resolveAgentRoute, buildAgentSessionKey },
      inbound: {
        buildContext: (ctx: Record<string, unknown>) => ctx,
        run: async ({
          raw,
          adapter,
          onTurnAdopted: receivedOnTurnAdopted,
        }: {
          raw: AgentMail.Message;
          adapter: Record<string, Function>;
          onTurnAdopted?: () => Promise<void>;
        }) => {
          expect(receivedOnTurnAdopted).toBe(onTurnAdopted);
          const ingested = adapter.ingest!(raw);
          turn = await adapter.resolveTurn!(ingested);
        },
      },
      session: {
        resolveStorePath: () => "/tmp/session.json",
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    };

    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: channelRuntime as never,
      client: { inboxes: { messages: { get } } } as never,
      onTurnAdopted,
    });

    expect(get).toHaveBeenCalledWith("inbox_1", "message_1");
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        peer: { kind: "direct", id: "inbox_1:thread:thread_1" },
      }),
    );
    expect(buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "main",
      channel: "agentmail",
      accountId: "default",
      peer: { kind: "direct", id: "inbox_1:thread:thread_1" },
      dmScope: "per-account-channel-peer",
    });
    const delivery = turn?.delivery as { durable: () => Record<string, unknown> };
    expect(delivery.durable()).toMatchObject({
      to: "message:message_1",
      replyToId: "message_1",
      threadId: "thread_1",
      requiredCapabilities: { reconcileUnknownSend: true },
    });
    expect(turn?.replyOptions).toEqual({
      disableBlockStreaming: true,
      sourceReplyDeliveryMode: "automatic",
    });
  });

  it("denies an unauthorized hydrated sender without dispatch", async () => {
    const run = vi.fn();
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: {
        inbound: { run },
      } as never,
      client: {
        inboxes: { messages: { get: vi.fn(async () => message({ from: "other@example.com" })) } },
      } as never,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("settles permanently unsafe hydrated messages without dispatch", async () => {
    const run = vi.fn();
    const warn = vi.fn();
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: { inbound: { run } } as never,
        client: {
          inboxes: { messages: { get: vi.fn(async () => message({ labels: ["spam"] })) } },
        } as never,
        log: { warn },
      }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsafe hydrated message"));
  });

  it("rejects a REST-listed outbound message without a received label", async () => {
    const run = vi.fn();
    await dispatchAgentMailInboundEvent({
      cfg: {},
      account,
      record,
      channelRuntime: { inbound: { run } } as never,
      client: {
        inboxes: { messages: { get: vi.fn(async () => message({ labels: ["sent"] })) } },
      } as never,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("retries a recent hydration 404 instead of permanently losing the message", async () => {
    const notFound = new AgentMailError({ message: "not found", statusCode: 404 });
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record: { ...record, receivedAt: 1_000 },
        channelRuntime: { inbound: { run: vi.fn() } } as never,
        client: {
          inboxes: {
            messages: {
              get: vi.fn(async () => {
                throw notFound;
              }),
            },
          },
        } as never,
        now: () => 1_000 + 60_000,
      }),
    ).rejects.toBe(notFound);
  });

  it("settles an unavailable message after the bounded hydration retry window", async () => {
    const run = vi.fn();
    const warn = vi.fn();
    await expect(
      dispatchAgentMailInboundEvent({
        cfg: {},
        account,
        record,
        channelRuntime: { inbound: { run } } as never,
        client: {
          inboxes: {
            messages: {
              get: vi.fn(async () => {
                throw new AgentMailError({ message: "not found", statusCode: 404 });
              }),
            },
          },
        } as never,
        log: { warn },
        now: () => 10 * 60_000,
      }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("hydration retry window"));
  });
});
