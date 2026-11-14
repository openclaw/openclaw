import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../../test-support/hanging-loopback-server.js";
import { setMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient, type MattermostPost } from "./client.js";
import { createMattermostPostHandler } from "./monitor-posts.js";
import { createMattermostThreadBackfill } from "./monitor-thread-backfill.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { createChannelHistoryWindow } from "./runtime-api.js";
import type { HistoryEntry, OpenClawConfig } from "./runtime-api.js";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("./monitor-turn.js", () => ({ dispatchMattermostInboundTurn: dispatch }));

// Real loopback requests can leave Undici timers retaining the retired fake clock.
const undiciTimers: { reset: () => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);
const makePost = (id: string, message: string, create_at: number): MattermostPost => ({
  id,
  message,
  create_at,
  channel_id: "room",
  user_id: "trusted",
  ...(id === "root" ? {} : { root_id: "root" }),
});
type Handler = ReturnType<typeof createMattermostPostHandler>;
const receive = (handler: Handler, post: MattermostPost, sender = "trusted") =>
  handler(post as never, { data: { sender_name: sender } });
const historyIds = (history: readonly { messageId?: string }[] | undefined) =>
  history?.map((entry) => entry.messageId);

let directory: string;
let server: Server;
let baseUrl: string;
let requests: string[];
let posts: MattermostPost[];
let beforeResponse: ((url: string) => Promise<void>) | undefined;
let responseStatus: number;
let responseError: string | undefined;

function holdResponse() {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  beforeResponse = async () => {
    entered.resolve();
    await release.promise;
  };
  return { entered, release };
}

beforeEach(async () => {
  setMattermostRuntime(createPluginRuntimeMock());
  dispatch.mockReset();
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mattermost-history-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  requests = [];
  beforeResponse = undefined;
  responseStatus = 200;
  responseError = undefined;
  posts = [
    makePost("root", "Next year France", 10),
    makePost("reply", "remember that", 20),
    makePost("current", "@bot where next year?", 30),
  ];
  server = createServer((request, response) => {
    void (async () => {
      requests.push(request.url ?? "");
      await beforeResponse?.(request.url ?? "");
      response.statusCode = responseStatus;
      response.setHeader("content-type", "application/json");
      let body: unknown;
      if (responseError) {
        body = { message: responseError };
      } else if (request.url?.startsWith("/api/v4/posts/root/thread")) {
        body = {
          order: posts.map((post) => post.id).toReversed(),
          posts: Object.fromEntries(posts.map((post) => [post.id, post])),
        };
      } else if (request.url === "/api/v4/users/ids") {
        body = [{ id: "trusted", username: "trusted-name" }];
      } else {
        response.statusCode = 404;
        body = { message: "unexpected request" };
      }
      response.end(JSON.stringify(body));
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const port = await listenOnLoopback(server);
  baseUrl = `http://127.0.0.1:${port}`;
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

async function setup(kind: "channel" | "direct" = "channel") {
  const credentials = { baseUrl, botToken: "disposable-token" };
  const cfg: OpenClawConfig = {
    session: { store: path.join(directory, "sessions.json") },
    channels: {
      mattermost: {
        enabled: true,
        ...credentials,
        network: { dangerouslyAllowPrivateNetwork: true },
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        streaming: { mode: "off" },
        replyToModeByChatType: { direct: "first" },
        historyLimit: 3,
      },
    },
  };
  const account = resolveMattermostAccount({ cfg, accountId: "default" });
  const baseKey = `agent:main:mattermost:${kind}:room`;
  const route = { agentId: "main", accountId: "default", sessionKey: baseKey };
  const sessionKey = `${baseKey}:thread:root`;
  const session = { agentId: "main", storePath: cfg.session?.store, sessionKey };
  const rotate = (sessionId = "replacement", lifecycleRevision = "generation-2") =>
    upsertSessionEntry({
      ...session,
      entry: { sessionId, lifecycleRevision, updatedAt: Date.now() },
    });
  await rotate("stored-session", "generation-1");
  const monitor = {
    cfg,
    account,
    client: createMattermostClient({ ...credentials, allowPrivateNetwork: true }),
    botUserId: "bot",
    botUsername: "bot",
    groupPolicy: "open",
    pairing: { readAllowFromStore: async () => [] },
    resources: {
      resolveChannelInfo: async () => ({
        id: "room",
        type: kind === "direct" ? "D" : "O",
      }),
      resolveUserInfo: async (id: string) => ({ id, username: id }),
      resolveMattermostMedia: async () => [],
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    logVerboseMessage: vi.fn(),
    logDebugMessage: vi.fn(),
    core: {
      channel: {
        inbound: { buildContext: buildChannelInboundEventContext },
        routing: { resolveAgentRoute: () => route },
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
  return {
    handler: createMattermostPostHandler(monitor),
    monitor,
    sessionKey,
    histories,
    recover,
    turn,
    rotate,
    remove: () => deleteSessionEntry(session),
  };
}

it("filters concurrent later history from the older turn without losing it", async () => {
  const f = await setup("channel");
  f.monitor.groupPolicy = "allowlist";
  f.monitor.account.config.groupAllowFrom = ["trusted"];
  const handler = createMattermostPostHandler(f.monitor);
  const { entered, release } = holdResponse();
  const pending = receive(handler, posts[2]!);
  await entered.promise;
  for (let index = 0; index < 3; index++) {
    await receive(
      handler,
      {
        ...posts[1]!,
        id: `later-${index}`,
        user_id: "denied",
        message: `later live fact ${index}`,
        create_at: 35 + index,
      },
      "denied",
    );
  }
  release.resolve();
  await pending;
  const first = dispatch.mock.calls[0]?.[1].ctxPayload;
  expect(first.Body).toContain("Next year France");
  expect(first.Body).not.toContain("later live fact");
  expect(historyIds(first.InboundHistory)).toEqual(["root", "reply"]);
  await receive(handler, { ...posts[2]!, id: "next-turn", create_at: 40 });
  expect(dispatch.mock.calls[1]?.[1].ctxPayload.Body).toContain("later live fact");
  expect(requests).toHaveLength(1);
});

it.each(["channel", "direct"] as const)(
  "recovers chronological %s history for an older coalesced turn",
  async (kind) => {
    const f = await setup(kind);
    const newer = { ...posts[2]!, id: "newer-trigger", create_at: 50 };
    posts.push({ ...posts[1]!, id: "middle", create_at: 40 }, newer);
    const { entered, release } = holdResponse();
    const first = receive(f.handler, newer);
    await entered.promise;
    const olderReady = createDeferred<void>();
    vi.mocked(f.monitor.core.channel.activity.record).mockImplementationOnce(() => {
      olderReady.resolve();
    });
    const older = receive(f.handler, posts[2]!);
    await olderReady.promise;
    release.resolve();
    await Promise.all([first, older]);
    const context = dispatch.mock.calls.find(
      (call) => call[1].ctxPayload.MessageSid === "current",
    )?.[1].ctxPayload;
    expect(historyIds(context.InboundHistory)).toEqual(["root", "reply"]);
    expect(context.Body).toContain("Next year France");
    expect(requests).toHaveLength(1);
  },
);

it("does not adopt a completed missing-session success across an unobserved reset", async () => {
  const f = await setup("channel");
  await f.remove();
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

it("keeps warm windows and recovers after actual history LRU eviction", async () => {
  const f = await setup("channel");
  const window = createChannelHistoryWindow({ historyMap: f.histories });
  const record = (historyKey: string, body = "live") =>
    window.record({ historyKey, limit: 3, entry: { sender: "trusted", body } });
  record(f.sessionKey, "warm");
  await f.recover(f.turn);
  expect(requests).toHaveLength(0);
  window.clear({ historyKey: f.sessionKey, limit: 3 });
  await f.recover(f.turn);
  expect(requests).toHaveLength(0);
  for (let index = 0; index < 1000; index++) {
    record(`other-${index}`);
  }
  expect(f.histories.has(f.sessionKey)).toBe(false);
  await f.recover(f.turn);
  expect(requests).toHaveLength(1);
  expect(f.histories.size).toBe(1000);
  expect(f.histories.get(f.sessionKey)?.[0]?.body).toBe("Next year France");
});

it("uses shared ingress and allowlist_quote visibility without pairing", async () => {
  const f = await setup("channel");
  f.monitor.groupPolicy = "allowlist";
  f.monitor.account.config.allowFrom = ["trusted"];
  f.monitor.cfg.channels!.mattermost!.contextVisibility = "allowlist_quote";
  posts[1]!.user_id = "denied";
  posts[1]!.message = "denied sender history";
  await f.recover(f.turn);
  expect(historyIds(f.histories.get(f.sessionKey))).toEqual(["root"]);
});

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

it("does not retry permanent provider failure on an absent history key", async () => {
  const f = await setup("channel");
  vi.useFakeTimers({ toFake: ["Date"] });
  responseStatus = 403;
  responseError = "Permission denied despite upstream too many requests (Mattermost API 503)";
  await f.recover(f.turn);
  vi.setSystemTime(Date.now() + 60_001);
  await f.recover(f.turn);
  expect(requests).toHaveLength(1);
  expect(f.histories.size).toBe(0);
});

it("bounds the full authorization deadline and retains capacity across marker eviction", async () => {
  const f = await setup("direct");
  f.monitor.account.config.dmPolicy = "pairing";
  // Keep socket and session-store I/O real; scheduling delay is not recovery time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
  const completed = vi.fn();
  const pending = Array.from({ length: 8 }, (_, index) =>
    f.recover({ ...f.turn, historyKey: `${f.sessionKey}-${index}` }).then(completed),
  );
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(completed).toHaveBeenCalledTimes(8);
    await Promise.all(pending);
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
    undiciTimers.reset();
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
  expect(historyIds(f.histories.get(f.sessionKey))).toEqual(["root", "reply"]);
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
