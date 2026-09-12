// Line tests cover inbound replies chunking at the limit live for each event.
import {
  buildChannelInboundEventContext,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type LineHandleWebhook = ReturnType<typeof import("./bot.js").createLineBot>["handleWebhook"];
type LineBotOptions = Parameters<typeof import("./bot.js").createLineBot>[0];
type ResolvedTurn = Pick<ChannelInboundTurnPlan, "delivery">;

const {
  createLineBotMock,
  createLineNodeWebhookHandlerMock,
  deliverLineAutoReplyMock,
  registerWebhookTargetWithPluginRouteMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn((_options: LineBotOptions) => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
    stop: vi.fn(async () => {}),
  })),
  createLineNodeWebhookHandlerMock: vi.fn(() => async () => {}),
  deliverLineAutoReplyMock: vi.fn(),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, danger: (value: unknown) => String(value), logVerbose: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

// The provider builds a real node webhook handler and hands work to the detached
// webhook runner; leaving either unmocked keeps the worker alive after the test ends.
vi.mock("./webhook-node.js", async () => {
  const actual = await vi.importActual<typeof import("./webhook-node.js")>("./webhook-node.js");
  return { ...actual, createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock };
});

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-request-guards")>(
    "openclaw/plugin-sdk/webhook-request-guards",
  );
  return { ...actual, runDetachedWebhookWork: vi.fn() };
});

vi.mock("./auto-reply-delivery.js", () => ({ deliverLineAutoReply: deliverLineAutoReplyMock }));
vi.mock("./markdown-to-line.js", () => ({ processLineMessage: vi.fn() }));
vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessagesLine: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(async () => {}),
}));
vi.mock("./template-messages.js", () => ({ buildTemplateMessageFromPayload: vi.fn() }));

const { monitorLineProvider } = await import("./monitor.js");
const { setLineRuntime } = await import("./runtime.js");

afterAll(() => {
  vi.doUnmock("./bot.js");
  vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
  vi.doUnmock("./webhook-node.js");
  vi.doUnmock("./auto-reply-delivery.js");
  vi.doUnmock("./markdown-to-line.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./template-messages.js");
  vi.resetModules();
});

beforeEach(() => {
  createLineBotMock.mockClear();
  createLineNodeWebhookHandlerMock.mockClear();
  deliverLineAutoReplyMock.mockReset().mockResolvedValue({
    status: "delivered",
    replyTokenUsed: true,
    visibleReplySent: true,
  });
  // The provider unregisters its route on stop, so the double has to hand one back.
  registerWebhookTargetWithPluginRouteMock
    .mockReset()
    .mockImplementation((params: { target: { path: string } }) => ({
      target: params.target,
      unregister: () => {},
    }));
});

/** A direct-message inbound context shaped by the same builders the LINE inbound path uses. */
function createInboundTextContext(
  accountId: string,
): Parameters<NonNullable<LineBotOptions["onMessage"]>>[0] {
  const conversation = { kind: "direct" as const, id: "U1" };
  const route = resolveAgentRoute({ cfg: {}, channel: "line", accountId, peer: conversation });
  const address = "line:U1";
  return {
    accountId,
    // No group skill scope configured, which is what `groupConfig?.skills` yields.
    skillFilter: undefined,
    ctxPayload: buildChannelInboundEventContext({
      channel: "line",
      accountId,
      messageId: "m1",
      timestamp: 1,
      from: address,
      sender: { id: "U1" },
      conversation,
      route: { agentId: route.agentId, accountId, routeSessionKey: route.sessionKey },
      reply: { to: address, originatingTo: address },
      message: { body: "hi", bodyForAgent: "hi", rawBody: "hi", commandBody: "hi" },
      access: { commands: { authorized: false } },
      media: [],
    }),
    event: {
      type: "message",
      mode: "active",
      timestamp: 1,
      webhookEventId: "evt-1",
      deliveryContext: { isRedelivery: false },
      replyToken: "reply-token",
      source: { type: "user", userId: "U1" },
      message: { type: "text", id: "m1", text: "hi", quoteToken: "test-quote-placeholder" },
    },
    isGroup: false,
    userId: "U1",
    groupId: undefined,
    roomId: undefined,
    replyToken: "reply-token",
    route,
    turn: {
      storePath: "store.sqlite",
      record: { updateLastRoute: undefined, onRecordError: () => {} },
    },
  };
}

describe("inbound reply chunking", () => {
  it("chunks an inbound reply at the limit live for that event", async () => {
    // The limit is configured per account but applied per reply: it only holds
    // if the delivery answering an inbound event carries it.
    setLineRuntime({
      channel: {
        inbound: {
          run: async (params: { adapter: { resolveTurn: () => ResolvedTurn } }) => {
            await params.adapter
              .resolveTurn()
              .delivery.deliver({ text: "reply" }, { kind: "final" });
            return { dispatched: false };
          },
        },
      },
    } as unknown as Parameters<typeof setLineRuntime>[0]);
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "work",
      config: {
        channels: { line: { textChunkLimit: 4000, accounts: { work: { textChunkLimit: 900 } } } },
      },
      runtime: {} as RuntimeEnv,
    });
    const onMessage = createLineBotMock.mock.calls[0]?.[0]?.onMessage;
    if (!onMessage) {
      throw new Error("expected the LINE bot to receive an inbound message handler");
    }

    try {
      // Admission hands every event its live config, so a reload between monitor
      // start and this event is the reachable case. Passing the start config back
      // would let a stale read pass: only a differing live value can tell them apart.
      await onMessage(createInboundTextContext("work"), {
        cfg: {
          channels: {
            line: { textChunkLimit: 4000, accounts: { work: { textChunkLimit: 1200 } } },
          },
        },
      });

      expect(deliverLineAutoReplyMock.mock.calls[0]?.[0]?.textLimit).toBe(1200);
    } finally {
      // A leaked registration makes later shared-path signature tests ambiguous.
      await monitor.stop();
    }
  });
});
