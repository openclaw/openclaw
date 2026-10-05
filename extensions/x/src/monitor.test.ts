import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openXAllowlist } from "./allowlist.js";
import { sendXDelivery } from "./send.js";
import {
  client,
  config,
  fixture,
  page,
  post,
  type Payload,
} from "./test-support/monitor-fixture.js";
import { createQueue } from "./test-support/monitor.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
  getXTokenState: () => "ready",
}));

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
