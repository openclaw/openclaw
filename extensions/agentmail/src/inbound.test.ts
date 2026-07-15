import { AgentMailError, type AgentMail } from "agentmail";
import { describe, expect, it, vi } from "vitest";
import { dispatchAgentMailInboundEvent, resolveAgentMailMessageText } from "./inbound.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

vi.mock("./media.js", () => ({
  loadAgentMailInboundAttachments: vi.fn(async () => ({ paths: [], types: [] })),
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
    labels: [],
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

describe("AgentMail REST-authoritative inbound", () => {
  it("uses HTML fallback from the hydrated message", () => {
    expect(
      resolveAgentMailMessageText(
        message({ text: undefined, extractedText: undefined, html: "<p>Hello <b>world</b></p>" }),
      ),
    ).toBe("Hello world");
  });

  it("hydrates positionally, keys sessions by inbox and thread, and fixes the reply target", async () => {
    const get = vi.fn(async () => message());
    const resolveAgentRoute = vi.fn(() => ({ agentId: "main", sessionKey: "session-thread-1" }));
    const buildAgentSessionKey = vi.fn(() => "session-thread-1");
    let turn: Record<string, unknown> | undefined;
    const channelRuntime = {
      routing: { resolveAgentRoute, buildAgentSessionKey },
      inbound: {
        buildContext: (ctx: Record<string, unknown>) => ctx,
        run: async ({
          raw,
          adapter,
        }: {
          raw: AgentMail.Message;
          adapter: Record<string, Function>;
        }) => {
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

  it("settles an authoritatively deleted message without retrying", async () => {
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
      }),
    ).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("deleted message"));
  });
});
