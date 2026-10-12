import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleChatAccount, type ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
import { startGoogleChatSpaceCache } from "./space-cache.js";
import { resolveGoogleChatOutboundSessionRoute } from "./targets.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  resolveAgentRoute: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  createChannelInboundEnvelopeBuilderAsync:
    async () =>
    ({ body }: { body: string }) =>
      body,
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/routing")>()),
  resolveAgentRoute: inboundMocks.resolveAgentRoute,
}));

vi.mock("./api.js", () => ({
  deleteGoogleChatMessage: apiMocks.deleteGoogleChatMessage,
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
  updateGoogleChatMessage: apiMocks.updateGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      eventProcessor: (event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>,
    ) => {
      routingMocks.processEvent = eventProcessor;
    },
  ),
}));

type GoogleChatTestReplyPayload = { text: string; replyToId?: string };
type GoogleChatTestDelivery = {
  durable: (payload: GoogleChatTestReplyPayload, info: { kind: string }) => unknown;
  deliver: (payload: GoogleChatTestReplyPayload) => Promise<void>;
};

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset().mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  inboundMocks.resolveAgentRoute.mockReset().mockReturnValue({
    agentId: "agent-1",
    accountId: "work",
    sessionKey: "session-1",
  });
});

function createCore(params: {
  run: (delivery: GoogleChatTestDelivery) => Promise<void>;
  chunks?: string[];
}) {
  return {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: vi.fn((payload: unknown) => payload),
        run: vi.fn(
          async (turn: {
            adapter: { resolveTurn: () => { delivery: GoogleChatTestDelivery } };
          }) => {
            await params.run(turn.adapter.resolveTurn().delivery);
          },
        ),
      },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => params.chunks ?? [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

function createEvent(params?: {
  messageName?: string | null;
  spaceType?: string;
}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: "spaces/CLASSIFY", spaceType: params?.spaceType ?? "SPACE" },
    message: {
      name:
        params?.messageName === null
          ? undefined
          : (params?.messageName ?? "spaces/CLASSIFY/messages/1"),
      text: "hello",
      thread: { name: "spaces/CLASSIFY/threads/requested" },
      sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
    },
  } satisfies GoogleChatEvent;
}

function createAccount(config: ResolvedGoogleChatAccount["config"]): ResolvedGoogleChatAccount {
  return {
    accountId: "work",
    config,
    credentialSource: "inline",
  } as ResolvedGoogleChatAccount;
}

async function processEvent(params: {
  account: ResolvedGoogleChatAccount;
  core: GoogleChatCoreRuntime;
  event?: GoogleChatEvent;
  runtime?: GoogleChatRuntimeEnv;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event ?? createEvent(), {
    account: params.account,
    config: {},
    runtime: params.runtime ?? { error: vi.fn(), log: vi.fn() },
    core: params.core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

const SPACE = "spaces/CLASSIFY";
const SOURCE = `${SPACE}/messages/1`;
const THREAD = `${SPACE}/threads/requested`;
const TYPING = `${SPACE}/messages/typing`;

describe("Google Chat automatic reply target reconciliation", () => {
  it("reuses inbound space classification for repeated outbound replies", async () => {
    const cfg = {
      channels: {
        googlechat: {
          accounts: {
            work: {
              serviceAccount: {
                client_email: "inbound@example.test",
                private_key: "not-a-real-key",
              },
            },
          },
        },
      },
    };
    const account = resolveGoogleChatAccount({ cfg, accountId: "work" });
    const stop = startGoogleChatSpaceCache(account);
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ messageName: `${SPACE}/messages/reply` });
    try {
      await processEvent({
        account,
        core: createCore({
          run: async (delivery) => {
            for (const text of ["first reply", "second reply"]) {
              await delivery.deliver({ text });
              expect(
                await resolveGoogleChatOutboundSessionRoute({
                  cfg,
                  accountId: "work",
                  agentId: "agent-1",
                  target: SPACE,
                }),
              ).toMatchObject({
                peer: { kind: "direct", id: SPACE },
                recipientSessionExact: true,
              });
            }
          },
        }),
        event: createEvent({ spaceType: "DIRECT_MESSAGE" }),
      });
      expect(
        apiMocks.sendGoogleChatMessage.mock.calls.slice(1).map(([params]) => params.text),
      ).toEqual(["first reply", "second reply"]);
    } finally {
      stop();
    }
  });

  it("keeps automatic replies top-level with reply mode off", async () => {
    const account = createAccount({ replyToMode: "off" });
    const payload = Object.freeze({ text: "top-level reply", replyToId: SOURCE });
    const core = createCore({
      run: async (delivery) => {
        await delivery.deliver(payload);
        expect(delivery.durable(payload, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: null,
        });
      },
    });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: `${SPACE}/threads/typing`,
    });
    await processEvent({ account, core });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: TYPING,
      text: payload.text,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
  });

  it("keeps the typing thread when automatic delivery supplies the source message name", async () => {
    const deliveredThread = `${SPACE}/threads/fallback`;
    const account = createAccount({ replyToMode: "all" });
    const core = createCore({
      chunks: ["first chunk", "second chunk"],
      run: async (delivery) => {
        await delivery.deliver(Object.freeze({ text: "two chunks", replyToId: SOURCE }));
      },
    });
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: TYPING, threadName: deliveredThread })
      .mockResolvedValueOnce({
        messageName: `${SPACE}/messages/second`,
        threadName: deliveredThread,
      });
    await processEvent({ account, core });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: TYPING,
      text: "first chunk",
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: SPACE,
      text: "_OpenClaw is typing..._",
      thread: THREAD,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: SPACE,
      text: "second chunk",
      thread: deliveredThread,
    });
  });

  it.each<{
    label: string;
    event?: GoogleChatEvent;
    thread?: string;
    failTyping?: boolean;
  }>([
    { label: "threaded after typing fails", thread: THREAD, failTyping: true },
    { label: "unknown source message", event: createEvent({ messageName: null }), thread: SOURCE },
    { label: "direct message", event: createEvent({ spaceType: "DIRECT_MESSAGE" }) },
  ])("reconciles delivery and durable metadata: $label", async ({ event, thread, failTyping }) => {
    const account = createAccount({
      replyToMode: "all",
      typingIndicator: failTyping ? "message" : "none",
    });
    const core = createCore({
      run: async (delivery) => {
        const payload = Object.freeze({ text: "reply", replyToId: SOURCE });
        expect(delivery.durable(payload, { kind: "final" })).toEqual(
          thread
            ? { to: SPACE, replyToId: thread, threadId: thread }
            : { to: SPACE, replyToId: null },
        );
        await delivery.deliver(payload);
      },
    });
    const runtime = { error: vi.fn(), log: vi.fn() };
    if (failTyping) {
      apiMocks.sendGoogleChatMessage.mockRejectedValueOnce(new Error("typing unavailable"));
    }
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: `${SPACE}/messages/reply`,
      threadName: thread,
    });
    await processEvent({ account, core, event, runtime });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(failTyping ? 2 : 1);
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith({
      account,
      space: SPACE,
      text: "reply",
      thread,
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    if (failTyping) {
      expect(runtime.error).toHaveBeenCalledWith(
        "Failed sending typing message: Error: typing unavailable",
      );
    }
  });
});
