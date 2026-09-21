import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, type MattermostPost } from "./client.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import { createMattermostThreadBackfill } from "./monitor-thread-backfill.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createChannelHistoryWindow,
  type HistoryEntry,
  type OpenClawConfig,
} from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));

describe("Mattermost server thread recovery through the post handler", () => {
  let directory: string;
  let server: Server;
  let baseUrl: string;
  let requests: string[];
  let posts: MattermostPost[];
  let beforeResponse: ((url: string) => Promise<void>) | undefined;
  let responseStatus: number;

  beforeEach(async () => {
    dispatch.mockReset();
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mattermost-history-")));
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    requests = [];
    beforeResponse = undefined;
    responseStatus = 200;
    posts = [
      {
        id: "root",
        channel_id: "room",
        user_id: "trusted",
        message: "Next year France",
        create_at: 10,
      },
      {
        id: "reply",
        root_id: "root",
        channel_id: "room",
        user_id: "trusted",
        message: "remember that",
        create_at: 20,
      },
      {
        id: "current",
        root_id: "root",
        channel_id: "room",
        user_id: "trusted",
        message: "@bot where next year?",
        create_at: 30,
      },
    ];
    server = createServer((request, response) => {
      void (async () => {
        requests.push(request.url ?? "");
        await beforeResponse?.(request.url ?? "");
        response.statusCode = responseStatus;
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/api/v4/posts/root/thread")) {
          response.end(
            JSON.stringify({
              order: posts.map((post) => post.id).toReversed(),
              posts: Object.fromEntries(posts.map((post) => [post.id, post])),
            }),
          );
        } else if (request.url === "/api/v4/users/ids") {
          response.end(JSON.stringify([{ id: "trusted", username: "trusted-name" }]));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "unexpected request" }));
        }
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing HTTP address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function setup(kind: "channel" | "group" | "direct", threaded = true) {
    const cfg: OpenClawConfig = {
      session: { store: path.join(directory, "sessions.json") },
      channels: {
        mattermost: {
          enabled: true,
          baseUrl,
          botToken: "disposable-token",
          network: { dangerouslyAllowPrivateNetwork: true },
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          streaming: { mode: "off" },
          replyToModeByChatType: { direct: threaded ? "first" : "off" },
          historyLimit: 3,
        },
      },
    };
    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    const baseKey = `agent:main:mattermost:${kind}:room`;
    const sessionKey = threaded ? `${baseKey}:thread:root` : baseKey;
    await upsertSessionEntry({
      agentId: "main",
      storePath: cfg.session?.store,
      sessionKey,
      entry: {
        sessionId: "stored-session",
        lifecycleRevision: "generation-1",
        updatedAt: Date.now(),
      },
    });
    const monitor = {
      cfg,
      account,
      client: createMattermostClient({
        baseUrl,
        botToken: "disposable-token",
        allowPrivateNetwork: true,
      }),
      botUserId: "bot",
      botUsername: "bot",
      groupPolicy: "open",
      pairing: { readAllowFromStore: async () => [] },
      resources: {
        resolveChannelInfo: async () => ({
          id: "room",
          type: kind === "direct" ? "D" : kind === "group" ? "G" : "O",
        }),
        resolveUserInfo: async (id: string) => ({ id, username: id }),
        resolveMattermostMedia: async () => [],
      },
      runtime: { log: vi.fn(), error: vi.fn() },
      logVerboseMessage: vi.fn(),
      logDebugMessage: vi.fn(),
      core: {
        channel: {
          routing: {
            resolveAgentRoute: () => ({
              agentId: "main",
              accountId: "default",
              sessionKey: baseKey,
            }),
          },
          activity: { record: vi.fn() },
          commands: { shouldHandleTextCommands: () => false, isControlCommandMessage: () => false },
          mentions: { buildMentionRegexes: () => [], matchesMentionPatterns: () => false },
          groups: { resolveRequireMention: () => true },
        },
      },
    } as unknown as MattermostMonitorContext;
    const histories = new Map<string, HistoryEntry[]>();
    const recover = createMattermostThreadBackfill({
      monitor,
      channelHistories: histories,
      historyLimit: 3,
    });
    const turn = {
      historyKey: sessionKey,
      agentId: "main",
      channelId: "room",
      kind,
      threadRootId: "root",
      currentPostId: "current",
      currentPostTimestamp: 30,
    };
    const rotate = (sessionId = "replacement", lifecycleRevision = "generation-2") =>
      upsertSessionEntry({
        agentId: "main",
        storePath: cfg.session?.store,
        sessionKey,
        entry: { sessionId, lifecycleRevision, updatedAt: Date.now() },
      });
    return {
      handler: createMattermostPostHandler(monitor),
      monitor,
      sessionKey,
      histories,
      recover,
      turn,
      rotate,
    };
  }

  it.each(["fetch", "authorization"] as const)(
    "discards a session reset during %s without another inbound ensure",
    async (phase) => {
      const f = await setup(phase === "authorization" ? "direct" : "channel");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      if (phase === "fetch") {
        beforeResponse = async () => {
          entered.resolve();
          await release.promise;
        };
      } else {
        f.monitor.account.config.dmPolicy = "pairing";
        f.monitor.pairing.readAllowFromStore = async () => {
          entered.resolve();
          await release.promise;
          return ["trusted"];
        };
      }
      const pending = f.recover(f.turn);
      await entered.promise;
      await f.rotate();
      release.resolve();
      expect((await pending).current).toBe(false);
      expect(f.histories.size).toBe(0);
    },
  );

  it("rejects same-session lifecycle rotation and deletion while fetching", async () => {
    const f = await setup("channel");
    for (const remove of [false, true]) {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      beforeResponse = async () => {
        entered.resolve();
        await release.promise;
      };
      const pending = f.recover(f.turn);
      await entered.promise;
      if (remove) {
        await deleteSessionEntry({
          agentId: "main",
          storePath: f.monitor.cfg.session?.store,
          sessionKey: f.sessionKey,
        });
      } else {
        await f.rotate("stored-session", "rotated-generation");
      }
      release.resolve();
      expect((await pending).current).toBe(false);
      expect(f.histories.size).toBe(0);
    }
  });

  it("coalesces concurrent cold turns and preserves live history", async () => {
    const f = await setup("channel");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeResponse = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.recover(f.turn);
    await entered.promise;
    const shared = f.recover(f.turn);
    const live = {
      sender: "trusted",
      body: "concurrent live post",
      timestamp: 35,
      messageId: "live",
    };
    createChannelHistoryWindow({ historyMap: f.histories }).record({
      historyKey: f.sessionKey,
      entry: live,
      limit: 3,
    });
    release.resolve();
    await Promise.all([pending, shared]);
    expect(requests).toHaveLength(1);
    expect(f.histories.get(f.sessionKey)?.map((entry) => entry.messageId)).toEqual([
      "root",
      "reply",
      "live",
    ]);
    expect(f.histories.get(f.sessionKey)?.at(-1)).toBe(live);
  });

  it("filters concurrent later history from the older turn without losing it", async () => {
    const f = await setup("channel");
    f.monitor.groupPolicy = "allowlist";
    f.monitor.account.config.groupAllowFrom = ["trusted"];
    const handler = createMattermostPostHandler(f.monitor);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeResponse = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = handler(posts[2]! as never, { data: { sender_name: "trusted" } });
    await entered.promise;
    for (let index = 0; index < 3; index++) {
      await handler(
        {
          ...posts[1]!,
          id: `later-${index}`,
          user_id: "denied",
          message: `later live fact ${index}`,
          create_at: 35 + index,
        } as never,
        { data: { sender_name: "denied" } },
      );
    }
    release.resolve();
    await pending;
    const first = dispatch.mock.calls[0]?.[1].ctxPayload;
    expect(first.Body).not.toContain("later live fact");
    expect(first.InboundHistory?.map((entry: { messageId: string }) => entry.messageId)).toEqual([
      "root",
      "reply",
    ]);
    await handler({ ...posts[2]!, id: "next-turn", create_at: 40 } as never, {
      data: { sender_name: "trusted" },
    });
    expect(dispatch.mock.calls[1]?.[1].ctxPayload.Body).toContain("later live fact");
    expect(requests).toHaveLength(1);
  });

  it("preserves fetched history for an older turn that coalesces behind a newer trigger", async () => {
    const f = await setup("channel");
    const newer = { ...posts[2]!, id: "newer-trigger", create_at: 50 };
    posts.push({ ...posts[1]!, id: "middle", create_at: 40 }, newer);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeResponse = async () => {
      entered.resolve();
      await release.promise;
    };
    const first = f.handler(newer as never, { data: { sender_name: "trusted" } });
    await entered.promise;
    const older = f.handler(posts[2]! as never, { data: { sender_name: "trusted" } });
    release.resolve();
    await Promise.all([first, older]);
    const context = dispatch.mock.calls.find(
      (call) => call[1].ctxPayload.MessageSid === "current",
    )?.[1].ctxPayload;
    expect(context.InboundHistory?.map((entry: { messageId: string }) => entry.messageId)).toEqual([
      "root",
      "reply",
    ]);
    expect(requests).toHaveLength(1);
  });

  it("discards in-flight missing-session recovery when storage materializes", async () => {
    const f = await setup("channel");
    await deleteSessionEntry({
      agentId: "main",
      storePath: f.monitor.cfg.session?.store,
      sessionKey: f.sessionKey,
    });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    beforeResponse = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = f.recover(f.turn);
    await entered.promise;
    await f.rotate();
    release.resolve();
    expect((await pending).current).toBe(false);
    expect(f.histories.size).toBe(0);
    await f.recover(f.turn);
    expect(requests).toHaveLength(1);
  });

  it("does not adopt a completed missing-session success across an unobserved reset", async () => {
    const f = await setup("channel");
    await deleteSessionEntry({
      agentId: "main",
      storePath: f.monitor.cfg.session?.store,
      sessionKey: f.sessionKey,
    });
    await f.recover(f.turn);
    createChannelHistoryWindow({ historyMap: f.histories }).clear({
      historyKey: f.sessionKey,
      limit: 3,
    });
    await f.rotate("materialized", "created-generation");
    await f.rotate("materialized", "reset-generation");
    await f.recover(f.turn);
    expect(requests).toHaveLength(2);
    expect(f.histories.get(f.sessionKey)?.[0]?.body).toBe("Next year France");
  });

  it("late old completion cannot clear a newer session's history or retry owner", async () => {
    const f = await setup("channel");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let requestCount = 0;
    beforeResponse = async () => {
      if (++requestCount === 1) {
        entered.resolve();
        await release.promise;
      }
    };
    const old = f.recover(f.turn);
    await entered.promise;
    await f.rotate();
    await f.recover(f.turn);
    const newWindow = f.histories.get(f.sessionKey);
    release.resolve();
    expect((await old).current).toBe(false);
    expect(f.histories.get(f.sessionKey)).toBe(newWindow);
    await f.recover(f.turn);
    expect(requestCount).toBe(2);
  });

  it("keeps warm windows and recovers after actual history LRU eviction", async () => {
    const f = await setup("channel");
    const window = createChannelHistoryWindow({ historyMap: f.histories });
    window.record({
      historyKey: f.sessionKey,
      limit: 3,
      entry: { sender: "trusted", body: "warm" },
    });
    await f.recover(f.turn);
    expect(requests).toHaveLength(0);
    window.clear({ historyKey: f.sessionKey, limit: 3 });
    await f.recover(f.turn);
    expect(requests).toHaveLength(0);
    for (let index = 0; index < 1000; index++) {
      window.record({
        historyKey: `other-${index}`,
        limit: 3,
        entry: { sender: "trusted", body: "live" },
      });
    }
    expect(f.histories.has(f.sessionKey)).toBe(false);
    await f.recover(f.turn);
    expect(requests).toHaveLength(1);
    expect(f.histories.size).toBe(1000);
    expect(f.histories.get(f.sessionKey)?.[0]?.body).toBe("Next year France");
  });

  it.each(["all", "allowlist", "allowlist_quote"] as const)(
    "uses shared ingress and %s visibility without pairing",
    async (mode) => {
      const f = await setup("channel");
      f.monitor.groupPolicy = "allowlist";
      f.monitor.account.config.allowFrom = ["trusted"];
      f.monitor.cfg.channels!.mattermost!.contextVisibility = mode;
      posts[1]!.user_id = "denied";
      posts[1]!.message = "denied sender history";
      await f.recover(f.turn);
      expect(f.histories.get(f.sessionKey)?.map((entry) => entry.messageId)).toEqual(
        mode === "all" ? ["root", "reply"] : ["root"],
      );
    },
  );

  it("keeps directory lookup opt-in, bounded to one request, and failure-deny", async () => {
    const f = await setup("channel");
    f.monitor.account.config.dangerouslyAllowNameMatching = true;
    f.monitor.account.config.groupAllowFrom = ["trusted-name"];
    f.monitor.groupPolicy = "allowlist";
    f.monitor.cfg.channels!.mattermost!.contextVisibility = "allowlist";
    await f.recover(f.turn);
    expect(requests.filter((url) => url === "/api/v4/users/ids")).toHaveLength(1);
    expect(f.histories.get(f.sessionKey)).toHaveLength(2);
    await f.rotate();
    f.histories.clear();
    beforeResponse = async (url) => {
      if (url.endsWith("/users/ids")) {
        responseStatus = 503;
      }
    };
    await f.recover(f.turn);
    expect(f.histories.size).toBe(0);
  });

  it("preserves cooldown and three-attempt budget across pending session materialization", async () => {
    const f = await setup("channel");
    await deleteSessionEntry({
      agentId: "main",
      storePath: f.monitor.cfg.session?.store,
      sessionKey: f.sessionKey,
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    responseStatus = 503;
    await f.recover(f.turn);
    await f.rotate();
    await f.recover(f.turn);
    expect(requests).toHaveLength(1);
    for (let index = 0; index < 4; index++) {
      vi.setSystemTime(Date.now() + 60_001);
      await f.recover(f.turn);
    }
    expect(requests).toHaveLength(3);
    await f.rotate("next-session", "next-generation");
    await f.recover(f.turn);
    expect(requests).toHaveLength(4);
  });

  it("does not retry permanent provider failure on an absent history key", async () => {
    const f = await setup("channel");
    responseStatus = 403;
    await f.recover(f.turn);
    await f.recover(f.turn);
    expect(requests).toHaveLength(1);
    expect(f.histories.size).toBe(0);
  });

  it("bounds the full authorization deadline and retains capacity across marker eviction", async () => {
    const f = await setup("direct");
    f.monitor.account.config.dmPolicy = "pairing";
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let lookups = 0;
    f.monitor.pairing.readAllowFromStore = async () => {
      if (++lookups === 8) {
        entered.resolve();
      }
      await release.promise;
      return ["trusted"];
    };
    const started = performance.now();
    const pending = Array.from({ length: 8 }, (_, index) =>
      f.recover({ ...f.turn, historyKey: `${f.sessionKey}-${index}` }),
    );
    try {
      await entered.promise;
      await Promise.all(pending);
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(f.histories.size).toBe(0);
      expect(requests).toHaveLength(8);
      for (let index = 0; index < 1005; index++) {
        await f.recover({ ...f.turn, historyKey: `${f.sessionKey}-pressure-${index}` });
      }
      await f.recover({ ...f.turn, historyKey: `${f.sessionKey}-0` });
      expect(requests).toHaveLength(8);
    } finally {
      release.resolve();
      await Promise.all(pending);
    }
  }, 15_000);

  it("excludes later, foreign-thread and system posts even when returned by the server", async () => {
    const f = await setup("channel");
    posts.push(
      { ...posts[1]!, id: "future", create_at: 40 },
      { ...posts[1]!, id: "foreign", channel_id: "different-room" },
      { ...posts[1]!, id: "different-thread", root_id: "elsewhere" },
      { ...posts[1]!, id: "system", type: "system_join_channel" },
    );
    await f.recover(f.turn);
    expect(f.histories.get(f.sessionKey)?.map((entry) => entry.messageId)).toEqual([
      "root",
      "reply",
    ]);
    const query = new URL(requests[0]!, baseUrl).searchParams;
    expect(query.get("fromPost")).toBe("current");
    expect(query.get("fromCreateAt")).toBe("30");
    expect(Number(query.get("perPage"))).toBeLessThanOrEqual(200);
  });

  it("store-reader failure cannot admit recovered DM history even with a configured sender", async () => {
    const f = await setup("direct");
    f.monitor.account.config.dmPolicy = "pairing";
    f.monitor.account.config.allowFrom = ["trusted"];
    f.monitor.pairing.readAllowFromStore = async () => {
      throw new Error("unreadable disposable store");
    };
    await f.recover(f.turn);
    expect(f.histories.size).toBe(0);
  });

  it.each(["channel", "group", "direct"] as const)(
    "recovers cold %s thread context in chronological order, excluding the trigger",
    async (kind) => {
      const { handler } = await setup(kind);
      await handler(posts[2]! as never, { data: { sender_name: "trusted" } });
      const context = dispatch.mock.calls[0]?.[1].ctxPayload;
      expect(
        context.InboundHistory?.map((entry: { messageId: string }) => entry.messageId),
      ).toEqual(["root", "reply"]);
      expect(context.Body).toContain("Next year France");
      expect(requests.filter((url) => url.includes("/thread"))).toHaveLength(1);
    },
  );

  it("keeps flat DMs out of server recovery", async () => {
    const { handler } = await setup("direct", false);
    await handler(posts[2]! as never, { data: { sender_name: "trusted" } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });
});
