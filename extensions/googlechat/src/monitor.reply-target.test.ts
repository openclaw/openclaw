import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
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

type EventProcessor = (event: GoogleChatEvent, target: Record<string, unknown>) => Promise<void>;
const routingMocks = vi.hoisted(() => ({ processEvent: undefined as EventProcessor | undefined }));

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

// mock-isolation: capture delivery without issuing Google Chat API requests.
vi.mock("./api.js", () => apiMocks);
// mock-isolation: this routing fixture supplies its admitted access result.
vi.mock("./monitor-access.js", () => accessMocks);

// mock-isolation: capture the event processor without registering shared webhook state.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: (eventProcessor: EventProcessor) => {
    routingMocks.processEvent = eventProcessor;
  },
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
  });
  inboundMocks.resolveAgentRoute.mockReset().mockReturnValue({
    agentId: "agent-1",
    accountId: "work",
    sessionKey: "session-1",
  });
});

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
  run: (delivery: GoogleChatTestDelivery) => Promise<void>;
  chunks?: string[];
  event?: GoogleChatEvent;
  runtime?: GoogleChatRuntimeEnv;
}) {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: (payload: unknown) => payload,
        run: async (turn: {
          adapter: { resolveTurn: () => { delivery: GoogleChatTestDelivery } };
        }) => params.run(turn.adapter.resolveTurn().delivery),
      },
      text: {
        resolveChunkMode: () => "markdown",
        chunkMarkdownTextWithMode: (text: string) => params.chunks ?? [text],
      },
    },
  } as unknown as GoogleChatCoreRuntime;
  await routingMocks.processEvent(params.event ?? createEvent(), {
    account: params.account,
    config: {},
    runtime: params.runtime ?? { error: vi.fn(), log: vi.fn() },
    core,
    mediaMaxMb: 10,
    path: "/googlechat",
  });
}

const SPACE = "spaces/CLASSIFY";
const SOURCE = `${SPACE}/messages/1`;
const THREAD = `${SPACE}/threads/requested`;
const TYPING = `${SPACE}/messages/typing`;

const sent = (account: ResolvedGoogleChatAccount, text: string, thread?: string) => ({
  account,
  space: SPACE,
  text,
  thread,
});
const updated = (account: ResolvedGoogleChatAccount, text: string) => ({
  account,
  messageName: TYPING,
  text,
});

describe("Google Chat automatic reply target reconciliation", () => {
  it.each<{ typing: "message" | "none"; kind: string }>([
    { typing: "message", kind: "final" },
    { typing: "none", kind: "block" },
  ])("keeps $kind delivery with $typing typing off the durable path", async ({ typing, kind }) => {
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: THREAD,
    });
    await processEvent({
      account: createAccount({ replyToMode: "all", typingIndicator: typing }),
      run: async (delivery) => {
        expect(delivery.durable({ text: "hello", replyToId: THREAD }, { kind })).toBe(false);
      },
    });
  });

  it("keeps automatic replies top-level with reply mode off", async () => {
    const account = createAccount({ replyToMode: "off" });
    const payload = Object.freeze({ text: "top-level reply", replyToId: SOURCE });
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: TYPING,
      threadName: `${SPACE}/threads/typing`,
    });
    await processEvent({
      account,
      run: async (delivery) => {
        await delivery.deliver(payload);
        expect(delivery.durable(payload, { kind: "final" })).toEqual({
          to: SPACE,
          replyToId: null,
        });
      },
    });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith(updated(account, payload.text));
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledOnce();
  });

  it("keeps the typing thread when automatic delivery supplies the source message name", async () => {
    const deliveredThread = `${SPACE}/threads/fallback`;
    const account = createAccount({ replyToMode: "all" });
    apiMocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: TYPING, threadName: deliveredThread })
      .mockResolvedValueOnce({
        messageName: `${SPACE}/messages/second`,
        threadName: deliveredThread,
      });
    await processEvent({
      account,
      chunks: ["first chunk", "second chunk"],
      run: async (delivery) => {
        await delivery.deliver(Object.freeze({ text: "two chunks", replyToId: SOURCE }));
      },
    });
    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith(updated(account, "first chunk"));
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(
      1,
      sent(account, "_OpenClaw is typing..._", THREAD),
    );
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(
      2,
      sent(account, "second chunk", deliveredThread),
    );
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
    const runtime = { error: vi.fn(), log: vi.fn() };
    if (failTyping) {
      apiMocks.sendGoogleChatMessage.mockRejectedValueOnce(new Error("typing unavailable"));
    }
    apiMocks.sendGoogleChatMessage.mockResolvedValue({
      messageName: `${SPACE}/messages/reply`,
      threadName: thread,
    });
    await processEvent({
      account,
      event,
      runtime,
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
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(failTyping ? 2 : 1);
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenLastCalledWith(sent(account, "reply", thread));
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    if (failTyping) {
      expect(runtime.error).toHaveBeenCalledWith(
        "Failed sending typing message: Error: typing unavailable",
      );
    }
  });
});
