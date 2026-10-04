import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveXAccount, type ResolvedXAccount } from "./accounts.js";
import { openXAllowlist } from "./allowlist.js";
import type { XApiClient, XPage, XPost } from "./api.js";
import { startXAccount } from "./monitor.js";
import { setXRuntime } from "./runtime.js";
import { sendXDelivery } from "./send.js";
import { createKeyedState, createQueue } from "./test-support/monitor.js";

const client = vi.hoisted(() => ({ getXApi: vi.fn() }));
vi.mock("./client.js", () => ({ getXApi: client.getXApi, getXTokenState: () => "ready" }));

type Payload = { version: number; rawEvent: string };
type Plan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];

function post(id: string, authorId: string, text = "@roboclawbot please help"): XPost {
  return {
    id,
    author_id: authorId,
    conversation_id: "500",
    text,
    created_at: "2026-09-08T12:00:00Z",
  };
}
function page(data: XPost[]): XPage {
  return {
    data,
    includes: {
      tweets: [],
      users: [
        { id: "10", username: "config_maintainer" },
        { id: "30", username: "stored_maintainer" },
      ],
    },
    meta: {},
  };
}
const config: OpenClawConfig = {
  agents: { list: [{ id: "maintainer" }] },
  bindings: [
    {
      agentId: "maintainer",
      match: { channel: "x", accountId: "default", peer: { kind: "group", id: "500" } },
    },
  ],
  channels: {
    x: {
      userId: "100",
      username: "roboclawbot",
      clientId: "test-client",
      clientSecret: "test-secret",
      refreshToken: "test-refresh",
      allowFrom: ["x:10"],
      groupPolicy: "allowlist",
      events: { mode: "poll", pollSeconds: 60 },
      replySignature: "",
    },
  },
};

function fixture(options: {
  posts: XPost[];
  queue?: ChannelIngressQueue<Payload>;
  onCursor?: () => void;
  cfg?: OpenClawConfig;
}) {
  const cfg = options.cfg ?? config;
  const replies: Array<{ text: string; parent: string }> = [];
  const api = {
    getMentions: vi.fn(async (_params: Parameters<XApiClient["getMentions"]>[0]) =>
      page(options.posts),
    ),
    getPosts: vi.fn(async (ids: string[]) =>
      page(options.posts.filter((value) => ids.includes(value.id))),
    ),
    searchConversation: vi.fn(async () => page([post("500", "10", "Original thread")])),
    getUserByUsername: vi.fn(async () => {
      throw new Error("Unexpected user lookup");
    }),
    reply: vi.fn(async (params: Parameters<XApiClient["reply"]>[0]) => {
      await params.assertActive?.();
      replies.push({ text: params.text, parent: params.inReplyToId });
      return String(900 + replies.length);
    }),
    ensureActivitySubscriptions: vi.fn(async () => {}),
    openActivityStream: vi.fn(async () => {
      throw new Error("Unexpected stream");
    }),
  } satisfies XApiClient;
  client.getXApi.mockResolvedValue(api);
  const resolveStable = vi.fn(resolveStableChannelMessageIngress);
  const dispatch = vi.fn(async (plan: Plan) => {
    plan.replyOptions?.onVisibleWorkSessions?.([
      {
        sessionKey: "agent:maintainer:work:example",
        url: "https://example.test/work/42",
        label: "Work session",
      },
    ]);
    if (!plan.delivery.deliver) {
      throw new Error("Missing X text delivery adapter");
    }
    await plan.delivery.deliver({ text: "I am on it." }, { kind: "final" });
    await plan.turnAdoptionLifecycle?.onAdopted();
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true as const,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
    };
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const openKeyedStore = createKeyedState((namespace, value) => {
    if (namespace === "x.cursor" && value && typeof value === "object" && "sinceId" in value) {
      options.onCursor?.();
    }
  });
  const queue = options.queue ?? createQueue<Payload>();
  // The host doubles expose only the runtime facilities this channel consumes.
  const runtime = {
    state: { openKeyedStore, openChannelIngressQueue: () => queue },
    logging: { getChildLogger: () => logger },
    channel: {
      inbound: {
        ingress: { resolveStable },
        buildContext: buildChannelInboundEventContext,
        dispatch,
      },
    },
  } as unknown as PluginRuntime;
  setXRuntime(runtime);
  const running: Array<{ abort: AbortController; run: Promise<unknown> }> = [];
  const start = () => {
    const abort = new AbortController();
    let status: ReturnType<ChannelGatewayContext<ResolvedXAccount>["getStatus"]> = {
      accountId: "default",
    };
    const context: ChannelGatewayContext<ResolvedXAccount> = {
      cfg,
      accountId: "default",
      account: resolveXAccount(cfg, "default"),
      abortSignal: abort.signal,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: (code) => {
          throw new Error(`Unexpected runtime exit: ${code}`);
        },
      },
      getStatus: () => status,
      setStatus: (next) => {
        status = next;
      },
    };
    const run = startXAccount(context);
    running.push({ abort, run });
    return { abort, run, status: () => status };
  };
  return {
    api,
    replies,
    dispatch,
    resolveStable,
    logger,
    runtime,
    openKeyedStore,
    start,
    async stop() {
      for (const item of running) {
        item.abort.abort();
      }
      await Promise.all(running.map((item) => item.run));
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  client.getXApi.mockReset();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
});

describe("X account monitor", () => {
  it("classifies unsupported inbound media as not dispatched", async () => {
    const completed = Promise.withResolvers<void>();
    const test = fixture({
      posts: [post("501", "10")],
      queue: createQueue<Payload>({ onCompleted: () => completed.resolve() }),
    });
    test.start();
    try {
      await completed.promise;
      const deliver = test.dispatch.mock.calls[0]![0].delivery.deliver!;
      const sentBefore = test.replies.length;
      for (const payload of [
        { mediaUrl: "https://example.test/image.png" },
        { text: "Attached", mediaUrls: ["https://example.test/image.png"] },
      ]) {
        await expect(deliver(payload, { kind: "final" })).rejects.toMatchObject({
          code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
          retryable: false,
        });
      }
      expect(test.replies).toHaveLength(sentBefore);
    } finally {
      await test.stop();
    }
  });

  it("uses a binding published while fetching the thread for the incoming turn", async () => {
    setRuntimeConfigSnapshot(config);
    const completed = Promise.withResolvers<void>();
    const test = fixture({
      posts: [post("501", "10")],
      cfg: getRuntimeConfigSnapshot() ?? config,
      queue: createQueue<Payload>({ onCompleted: () => completed.resolve() }),
    });
    test.api.searchConversation.mockImplementationOnce(async () => {
      setRuntimeConfigSnapshot({
        ...config,
        agents: { list: [{ id: "updated" }] },
        bindings: [
          {
            agentId: "updated",
            match: { channel: "x", accountId: "default", peer: { kind: "group", id: "500" } },
          },
        ],
      });
      return page([post("500", "10", "Original thread")]);
    });
    test.start();
    try {
      await completed.promise;
      expect(test.dispatch).toHaveBeenCalledOnce();
      expect(test.dispatch.mock.calls[0]![0].route).toEqual({
        agentId: "updated",
        sessionKey: "agent:updated:x:group:500",
      });
    } finally {
      await test.stop();
    }
  });

  it("routes config and stored authors as group turns, ignores strangers before reads, and retains queue identities on restart", async () => {
    const complete = Promise.withResolvers<void>();
    const cursor = Promise.withResolvers<void>();
    const redelivered = Promise.withResolvers<void>();
    const completed: string[] = [];
    let offers = 0;
    const queue = createQueue<Payload>({
      beforeEnqueue: async () => {
        if (++offers === 6) {
          redelivered.resolve();
        }
      },
      onCompleted: (id) => {
        completed.push(id);
        if (completed.length === 3) {
          complete.resolve();
        }
      },
    });
    const test = fixture({
      posts: [post("503", "30"), post("502", "99", "Untrusted mention"), post("501", "10")],
      queue,
      onCursor: () => cursor.resolve(),
    });
    await openXAllowlist(test.runtime).put("default", {
      userId: "30",
      username: "stored_maintainer",
      name: "Stored",
      addedBy: "operator",
      addedAt: 0,
    });
    const first = test.start();
    try {
      await Promise.all([complete.promise, cursor.promise]);
      expect(test.dispatch).toHaveBeenCalledTimes(2);
      expect(test.api.searchConversation).toHaveBeenCalledTimes(2);
      expect(test.api.getPosts).not.toHaveBeenCalled();
      expect(first.status()).toMatchObject({
        droppedMentions: 1,
        lastDroppedAuthor: "99",
        cursor: "503",
        mode: "poll",
      });
      expect(test.replies).toEqual([
        { parent: "501", text: "I am on it.\nhttps://example.test/work/42" },
        { parent: "503", text: "I am on it.\nhttps://example.test/work/42" },
      ]);
      const turn = test.dispatch.mock.calls[0]![0];
      expect(turn.route).toEqual({
        agentId: "maintainer",
        sessionKey: "agent:maintainer:x:group:500",
      });
      expect(turn.ctxPayload).toMatchObject({
        WasMentioned: true,
        GroupRequireMention: true,
        SessionKey: "agent:maintainer:x:group:500",
        ChatType: "group",
        SenderId: "10",
        SenderName: "@config_maintainer",
        MessageSid: "501",
        ReplyToId: "501",
        RawBody: "@roboclawbot please help",
        To: "x:501",
      });
      expect(turn.ctxPayload.BodyForAgent).toContain("Original thread");
      expect(turn.ctxPayload.BodyForAgent).toContain("[triggering mention]");
      expect(
        test.resolveStable.mock.calls.some(
          ([input]) =>
            input.contextBinding?.sessionKey === "agent:maintainer:x:group:500" &&
            input.contextBinding.inboundEventKind === "user_request",
        ),
      ).toBe(true);
      expect(test.logger.warn).not.toHaveBeenCalled();
      first.abort.abort();
      await first.run;
      const second = test.start();
      await redelivered.promise;
      await vi.advanceTimersByTimeAsync(0);
      second.abort.abort();
      await second.run;
      expect(test.api.getMentions.mock.calls[1]?.[0]).toMatchObject({ sinceId: "503" });
      expect(test.dispatch).toHaveBeenCalledTimes(2);
      expect(test.replies).toHaveLength(2);
      expect(completed).toEqual(["501", "502", "503"]);
    } finally {
      await test.stop();
    }
  });

  it("does not advance its cursor before the queue accepts the mention", async () => {
    const entered = Promise.withResolvers<void>();
    const accept = Promise.withResolvers<void>();
    const advanced = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const queue = createQueue<Payload>({
      beforeEnqueue: async () => {
        entered.resolve();
        await accept.promise;
      },
      onCompleted: () => completed.resolve(),
    });
    const test = fixture({ posts: [post("501", "10")], queue, onCursor: () => advanced.resolve() });
    test.start();
    try {
      await entered.promise;
      const cursorStore = test.openKeyedStore<{ userId: string; sinceId?: string }>({
        namespace: "x.cursor",
      });
      expect(await cursorStore.lookup("default")).toEqual({ userId: "100" });
      expect(test.dispatch).not.toHaveBeenCalled();
      accept.resolve();
      await Promise.all([advanced.promise, completed.promise]);
      expect(await cursorStore.lookup("default")).toEqual({ userId: "100", sinceId: "501" });
    } finally {
      accept.resolve();
      await test.stop();
    }
  });
});

describe("X direct delivery admission", () => {
  it.each([
    { label: "unmentioned post", authorId: "10", mentions: false, error: "only replies to posts" },
    { label: "unknown author", authorId: "99", mentions: true, error: "no longer allowed" },
  ])("refuses $label without posting", async ({ authorId, mentions, error }) => {
    const target = post("501", authorId);
    if (mentions) {
      target.entities = { mentions: [{ id: "100", username: "roboclawbot" }] };
    }
    const test = fixture({ posts: [target] });
    await expect(
      sendXDelivery({ cfg: config, to: "https://x.com/person/status/501", text: "Reply" }),
    ).rejects.toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: false,
      message: expect.stringContaining(error),
    });
    expect(test.replies).toEqual([]);
  });

  it.each(["client", "lookup"] as const)(
    "keeps %s preflight failures safely retryable",
    async (failure) => {
      const test = fixture({ posts: [] });
      if (failure === "client") {
        client.getXApi.mockRejectedValueOnce(new Error("X client unavailable"));
      } else {
        test.api.getPosts.mockRejectedValueOnce(new Error("X lookup unavailable"));
      }
      await expect(
        sendXDelivery({ cfg: config, to: "x:501", text: "Reply" }),
      ).rejects.toMatchObject({
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: true,
      });
      expect(test.api.reply).not.toHaveBeenCalled();
    },
  );

  it("retains the first post receipt when the next chunk fails before dispatch", async () => {
    const test = fixture({ posts: [] });
    test.api.reply
      .mockResolvedValueOnce("901")
      .mockRejectedValueOnce(
        new PlatformMessageNotDispatchedError("Token refresh unavailable", { cause: undefined }),
      );
    await expect(
      sendXDelivery({
        cfg: config,
        to: "x:501",
        mention: post("501", "10"),
        text: "a".repeat(300),
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      sentBeforeError: true,
      deliveryResult: { visibleReplySent: true, receipt: { platformMessageIds: ["901"] } },
    });
    expect(test.api.reply).toHaveBeenCalledTimes(2);
  });
});
