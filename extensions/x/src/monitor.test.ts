import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openXAllowlist } from "./allowlist.js";
import { createXApiClient } from "./api.js";
import { openXGuestUsage } from "./guest-usage.js";
import { sendXDelivery } from "./send.js";
import {
  client,
  config,
  fixture as createFixture,
  page,
  post,
  type Payload,
} from "./test-support/monitor-fixture.js";
import { createQueue } from "./test-support/monitor.js";
import { openXWorkOrigins } from "./work-origin.js";

type MonitorFixture = ReturnType<typeof createFixture>;
const frontDoor = "agent:maintainer:x:group:500";
const referenceHeading = "X work-session references";
const active: MonitorFixture[] = [];
function fixture({
  completeOn,
  ...options
}: Parameters<typeof createFixture>[0] & { completeOn?: string }) {
  const completed = Promise.withResolvers<void>();
  const queue =
    options.queue ??
    createQueue<Payload>({
      onCompleted: (id) => {
        if (!completeOn || id === completeOn) {
          completed.resolve();
        }
      },
    });
  const test = createFixture({ ...options, queue });
  active.push(test);
  return { ...test, completed: completed.promise };
}
function guestConfig(maxMentionsPerAuthorPerDay?: number) {
  return {
    ...config,
    messages: { queue: { mode: "collect" as const } },
    agents: { entries: { maintainer: { skills: [], tools: { fs: { workspaceOnly: true } } } } },
    channels: {
      x: { ...config.channels?.x, guests: { enabled: true, maxMentionsPerAuthorPerDay } },
    },
  };
}
function withRecipient(value: ReturnType<typeof post>, id = "100", username = "roboclawbot") {
  return { ...value, entities: { mentions: [{ id, username }] } };
}
function registerWork(
  test: MonitorFixture,
  key: string,
  origin: Partial<Parameters<ReturnType<typeof openXWorkOrigins>["registerIfAbsent"]>[1]> = {},
  entry: Partial<Parameters<MonitorFixture["sessionEntries"]["set"]>[1]> | null = {},
) {
  if (entry) {
    test.sessionEntries.set(key, {
      sessionId: key.split(":").at(-1)!,
      updatedAt: 1,
      createdVia: "spawn",
      spawnedBy: frontDoor,
      ...entry,
    });
  }
  return openXWorkOrigins(test.runtime).registerIfAbsent(key, {
    accountId: "default",
    conversationId: "500",
    postId: "501",
    postUrl: "https://x.com/config_maintainer/status/501",
    authorHandle: "config_maintainer",
    senderTier: "maintainer",
    ...origin,
  });
}

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

beforeEach(() => {
  vi.useFakeTimers();
  client.getXApi.mockReset();
});
afterEach(async () => {
  try {
    for (const test of active.splice(0)) {
      await test.stop();
    }
  } finally {
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
  }
});

describe("X account monitor", () => {
  it("carries a previous work session into a later mention without rerouting the front door", async () => {
    const workKey = "agent:worker:dashboard:existing-demo";
    const test = fixture({
      posts: [post("501", "10")],
      visibleSessionKey: workKey,
      completeOn: "502",
    });
    test.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = test.dispatch.mock.calls[0]![0];
    expect(first.ctxPayload.BodyForAgent).not.toContain(referenceHeading);
    test.sessionEntries.set(workKey, {
      sessionId: "existing-demo",
      updatedAt: 1,
      createdVia: "spawn",
      spawnedBy: first.route.sessionKey,
      displayName: "Private implementation notes must not be copied",
    });
    test.api.getMentions.mockResolvedValue(
      page([post("502", "10", "@roboclawbot update your demo")]),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await test.completed;
    const { ctxPayload: payload, route } = test.dispatch.mock.calls[1]![0];
    const body = payload.BodyForAgent;
    expect(route).toEqual(first.route);
    expect(body).toContain(referenceHeading);
    expect(body).toContain(workKey);
    expect(body).toContain("https://x.com/config_maintainer/status/501");
    expect(body).not.toContain("Private implementation notes");
    expect(payload).toMatchObject({ RawBody: "@roboclawbot update your demo", ReplyToId: "502" });
    expect(await openXWorkOrigins(test.runtime).lookup(workKey)).toMatchObject({ postId: "501" });
  });

  it.each([
    ["other account", { accountId: "other" }, {}],
    ["other conversation", { conversationId: "600" }, {}],
    ["guest origin", { senderTier: "guest" }, {}],
    ["guest turn", {}, {}],
    ["hidden helper", {}, {}],
    ["deleted", {}, null],
    ["archived", {}, { archivedAt: 1 }],
    ["draft", {}, { visibility: "draft" }],
    ["incognito", {}, { incognito: true }],
    ["initializing", {}, { initializationPending: true }],
    ["other source", {}, { spawnedBy: "agent:maintainer:x:group:600" }],
    ["not spawned", {}, { createdVia: "internal" }],
    ["self visibility", {}, {}, "maintainer", "self", true, false, false],
    ["tree visibility", {}, {}, "maintainer", "tree", true, false, true],
    ["cross-agent tree", {}, {}, "worker", "tree", true, false, false],
    ["disabled a2a", {}, {}, "worker", "all", false, false, false],
    ["sandboxed a2a", {}, {}, "worker", "all", true, true, false],
  ] as const)(
    "filters work-session references: %s",
    async (
      reason,
      origin,
      entry,
      agent = "maintainer",
      visibility?: "self" | "tree" | "all",
      enabled = true,
      sandboxed = false,
      included = false,
    ) => {
      const cfg = visibility
        ? { ...config, tools: { sessions: { visibility }, agentToAgent: { enabled } } }
        : reason === "guest turn"
          ? guestConfig()
          : config;
      const test = fixture({ posts: [post("502", reason === "guest turn" ? "20" : "10")], cfg });
      const key =
        reason === "hidden helper"
          ? "agent:maintainer:subagent:hidden"
          : `agent:${agent}:dashboard:previous`;
      await registerWork(test, key, origin, entry);
      if (sandboxed) {
        test.sessionEntries.set(frontDoor, {
          sessionId: "source",
          updatedAt: 1,
          sandbox: "required",
        });
      }
      test.start();
      await vi.advanceTimersByTimeAsync(0);
      await test.completed;
      expect(test.dispatch).toHaveBeenCalledOnce();
      const body = test.dispatch.mock.calls[0]![0].ctxPayload.BodyForAgent;
      if (included) {
        expect(body).toContain(key);
      } else {
        expect(body).not.toContain(referenceHeading);
      }
    },
  );

  it("bounds references deterministically without treating a new topic as routed work", async () => {
    const test = fixture({
      posts: [post("502", "10", "@roboclawbot a new, unrelated topic"), post("501", "10")],
      completeOn: "502",
    });
    for (let index = 9; index >= 0; index--) {
      const key = "agent:maintainer:dashboard:work-" + index;
      await registerWork(
        test,
        key,
        { postId: "499", postUrl: "https://x.com/config_maintainer/status/499" },
        { updatedAt: index },
      );
    }
    test.start();
    await vi.advanceTimersByTimeAsync(0);
    await test.completed;
    const [first, second] = test.dispatch.mock.calls.map(([plan]) => plan);
    const context = second!.ctxPayload.BodyForAgent!.split(referenceHeading)[1]!;
    expect(context).toBe(first!.ctxPayload.BodyForAgent!.split(referenceHeading)[1]);
    const references = context.split("\n").filter((line) => line.startsWith('{"sessionKey":'));
    expect(references).toHaveLength(8);
    expect(references[0]).toContain("agent:maintainer:dashboard:work-0");
    expect(references[7]).toContain("agent:maintainer:dashboard:work-7");
    expect(context).not.toContain("dashboard:work-8");
    expect(context).toContain("do not route by thread membership alone");
    expect(context).toContain("do not spawn a duplicate or claim the work resumed");
    expect(second!.route.sessionKey).toBe(frontDoor);
    expect(second!.ctxPayload.RawBody).toBe("@roboclawbot a new, unrelated topic");
  });

  it.each([
    { pollSeconds: 15, backfillMs: 60_000 },
    { pollSeconds: 60, backfillMs: 240_000 },
  ])(
    "backfills missed mentions every $backfillMs ms without admitting a streamed post twice",
    async ({ pollSeconds, backfillMs }) => {
      const mentions = [post("502", "10"), post("501", "10")];
      const admitted: string[] = [];
      const test = fixture({
        posts: mentions,
        queue: createQueue<Payload>({ onEnqueued: (id) => admitted.push(id) }),
        cfg: {
          ...config,
          channels: {
            ...config.channels,
            x: {
              ...config.channels?.x,
              bearerToken: "test-bearer",
              events: { mode: "stream", pollSeconds },
            },
          },
        },
      });
      const cursor = test.openKeyedStore<{ userId: string; sinceId?: string }>({
        namespace: "x.cursor",
      });
      await cursor.register("default", { userId: "100", sinceId: "500" });
      test.api.getMentions
        .mockResolvedValueOnce(page([]))
        .mockImplementation(async ({ sinceId }) =>
          page(mentions.filter((mention) => BigInt(mention.id) > BigInt(sinceId ?? "0"))),
        );
      const encoder = new TextEncoder();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      test.api.openActivityStream.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        ),
      );
      const running = test.start();
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        await vi.advanceTimersByTimeAsync(0);
        const data = { event_type: "post.mention.create", payload: withRecipient(mentions[0]!) };
        stream.enqueue(encoder.encode(`${JSON.stringify({ data })}\n`));
        await vi.advanceTimersByTimeAsync(0);
        expect(admitted).toEqual(["502"]);
        expect(test.replies.map((reply) => reply.parent)).toEqual(["502"]);
        keepAlive = setInterval(() => stream.enqueue(encoder.encode("\n")), 20_000);
        await vi.advanceTimersByTimeAsync(backfillMs - 1);
        expect(test.api.getMentions).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1);
        expect(test.api.getMentions).toHaveBeenCalledTimes(2);
        expect(test.api.getMentions.mock.calls[1]?.[0]).toMatchObject({ sinceId: "500" });
        expect(admitted).toEqual(["502", "501"]);
        expect(test.replies.map((reply) => reply.parent)).toEqual(["502", "501"]);
        expect(test.dispatch).toHaveBeenCalledTimes(2);
        expect(await cursor.lookup("default")).toEqual({ userId: "100", sinceId: "502" });
        expect(test.api.openActivityStream).toHaveBeenCalledOnce();
        expect(running.status()).toMatchObject({ connected: true, mode: "stream" });
      } finally {
        clearInterval(keepAlive);
        await test.stop();
      }
    },
  );

  it.each([
    { recipientId: "100", dispatches: 1, guest: false },
    { recipientId: "99", dispatches: 0, guest: false },
    { recipientId: "100", dispatches: 1, guest: true },
    { recipientId: "99", dispatches: 0, guest: true },
  ])(
    "verifies pending recipient $recipientId (guest=$guest) before quota and dispatch after budget reset",
    async ({ recipientId, dispatches, guest }) => {
      vi.setSystemTime(new Date("2026-10-05T23:59:59Z"));
      const completed = Promise.withResolvers<void>();
      const blocked = Promise.withResolvers<void>();
      const released: string[] = [];
      const authorId = guest ? "20" : "10";
      const queue = createQueue<Payload>({
        onCompleted: () => completed.resolve(),
        onReleased: (id) => released.push(id),
      });
      await queue.enqueue(
        "501",
        {
          version: 1,
          rawEvent: JSON.stringify({
            post: post("501", authorId),
            users: [],
            recipientPending: true,
          }),
        },
        { laneKey: "500" },
      );
      const test = fixture({ posts: [], queue, cfg: guest ? guestConfig(1) : config });
      const guestUsage = openXGuestUsage(test.runtime);
      await test.api.spend.charge(99_995_000);
      let lookups = 0;
      const api = createXApiClient({
        spend: test.api.spend,
        clientId: "client",
        clientSecret: "secret",
        refreshToken: "refresh",
        saveRefreshToken: async () => {},
        fetch: async (input) => {
          if (input.endsWith("/oauth2/token")) {
            return Response.json({ access_token: "access" });
          }
          lookups++;
          return Response.json({
            data: [withRecipient(post("501", authorId), recipientId, "bot")],
            includes: {
              users: [{ id: authorId, username: guest ? "guest" : "config_maintainer" }],
            },
          });
        },
      });
      test.api.getPosts.mockImplementation(async (ids) => {
        try {
          return await api.getPosts(ids);
        } catch (error) {
          blocked.resolve();
          throw error;
        }
      });
      const running = test.start();
      await blocked.promise;
      expect(test.dispatch).not.toHaveBeenCalled();
      expect(lookups).toBe(0);
      expect(await guestUsage.counts("default")).toEqual({ admittedToday: 0, rateLimitedToday: 0 });
      expect(running.status()).toMatchObject({
        spend: { dayUsd: 100, dailyLimitUsd: 100, monthlyLimitUsd: 1000 },
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(lookups).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await completed.promise;
      expect(lookups).toBe(1);
      expect(test.dispatch).toHaveBeenCalledTimes(dispatches);
      expect(await guestUsage.counts("default")).toEqual({
        admittedToday: guest ? dispatches : 0,
        rateLimitedToday: 0,
      });
      expect(released).toEqual([]);
      expect(running.status()).toMatchObject({ spend: { dayUsd: 0.02 } });
    },
  );

  it("uses a binding published while fetching the thread for the incoming turn", async () => {
    setRuntimeConfigSnapshot(config);
    const test = fixture({ posts: [post("501", "10")], cfg: getRuntimeConfigSnapshot() ?? config });
    test.api.searchConversation.mockImplementationOnce(async () => {
      setRuntimeConfigSnapshot({
        ...config,
        agents: { entries: { updated: {} } },
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
    await test.completed;
    expect(test.dispatch).toHaveBeenCalledOnce();
    expect(test.dispatch.mock.calls[0]![0].route).toEqual({
      agentId: "updated",
      sessionKey: "agent:updated:x:group:500",
    });
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
    expect(test.replies).toEqual(
      ["501", "503"].map((parent) => ({
        parent,
        text: "I am on it.\nWork session (sign-in required): https://example.test/work/42",
      })),
    );
    const turn = test.dispatch.mock.calls[0]![0];
    expect(turn.route).toEqual({ agentId: "maintainer", sessionKey: frontDoor });
    expect(turn.ctxPayload).toMatchObject({
      WasMentioned: true,
      GroupRequireMention: true,
      SessionKey: frontDoor,
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
    expect(test.resolveStable).toHaveBeenCalledWith(
      expect.objectContaining({
        contextBinding: expect.objectContaining({
          sessionKey: frontDoor,
          inboundEventKind: "user_request",
        }),
      }),
    );
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
    const target = mentions ? withRecipient(post("501", authorId)) : post("501", authorId);
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
