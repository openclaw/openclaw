import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtime from "./actions/runtime.messaging.runtime.js";
import { discordMessageActions } from "./channel-actions.js";
import { RequestClient } from "./internal/rest.js";
import { createJsonResponse } from "./internal/test-builders.test-support.js";

const channelId = "123456789012345678";
const messageId = "223456789012345678";
const guildId = "323456789012345678";
const userId = "423456789012345678";
const token = "synthetic-read-authority-token";
const channelPath = `/channels/${channelId}`;
const messagesPath = `${channelPath}/messages`;
const messagePath = `${messagesPath}/${messageId}`;
const guildPath = `/guilds/${guildId}`;
const channel = { id: channelId, type: 0, guild_id: guildId, name: "synthetic-channel" };
const message = {
  id: messageId,
  channel_id: channelId,
  content: "synthetic message",
  reactions: [{ emoji: { id: null, name: "ok" }, count: 1 }],
};
const cfg: OpenClawConfig = {
  channels: { discord: { token, groupPolicy: "open", guilds: { [guildId]: {} } } },
};
const originalRuntime = { ...runtime };
const fetchMock = vi.fn<typeof fetch>();

function requestPath(input: Parameters<typeof fetch>[0]) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://discord.com" || !url.pathname.startsWith("/api/v10/")) {
    throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`);
  }
  return url.pathname.slice("/api/v10".length);
}

function fixtureResponse(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const path = requestPath(input);
  expect(new Headers(init?.headers).get("Authorization")).toBe(`Bot ${token}`);
  const responses: Record<string, unknown> = {
    [channelPath]: channel,
    [messagesPath]: init?.method === "POST" ? message : [message],
    [messagePath]: message,
    [`${messagePath}/reactions/ok`]: [{ id: userId, username: "synthetic-user" }],
    [`${channelPath}/pins`]: [message],
    [`${channelPath}/threads/archived/public`]: { threads: [], members: [], has_more: false },
    [guildPath]: { id: guildId, name: "synthetic-guild", roles: [] },
    [`${guildPath}/messages/search`]: { messages: [[message]], total_results: 1 },
    [`${guildPath}/members/${userId}`]: { roles: [], user: { id: userId } },
    [`${guildPath}/roles`]: [],
    [`${guildPath}/channels`]: [channel],
    [`${guildPath}/emojis`]: [],
    [`${guildPath}/threads/active`]: { threads: [], members: [], has_more: false },
    [`${guildPath}/voice-states/${userId}`]: {
      guild_id: guildId,
      user_id: userId,
      channel_id: null,
    },
    [`${guildPath}/scheduled-events`]: [],
    "/users/%40me": { id: userId },
  };
  if (!(path in responses)) {
    throw new Error(`Unexpected fixture request: ${init?.method} ${path}`);
  }
  return createJsonResponse(responses[path]);
}

function invoke(overrides: Partial<ChannelMessageActionContext> = {}) {
  if (!discordMessageActions.handleAction) {
    throw new Error("Discord action adapter is missing");
  }
  return discordMessageActions.handleAction({
    channel: "discord",
    action: "read",
    cfg,
    params: { channelId, limit: 1 },
    ...overrides,
  });
}

function createAuthority() {
  let active = true;
  return {
    assert: () => {
      if (!active) {
        throw new Error("Conversation read authority revoked");
      }
    },
    revoke: () => {
      active = false;
    },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) => fixtureResponse(input, init));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Discord conversation read request authority", () => {
  const readActions: Pick<ChannelMessageActionContext, "action" | "params">[] = [
    { action: "read", params: { channelId } },
    { action: "search", params: { channelId, query: "synthetic" } },
    { action: "permissions", params: { channelId } },
    { action: "reactions", params: { channelId, messageId } },
    { action: "list-pins", params: { channelId } },
    { action: "thread-list", params: { guildId } },
    { action: "thread-list", params: { guildId, channelId, includeArchived: true } },
    { action: "member-info", params: { guildId, userId } },
    { action: "role-info", params: { guildId } },
    { action: "emoji-list", params: { channelId } },
    { action: "channel-info", params: { channelId } },
    { action: "channel-list", params: { guildId } },
    { action: "voice-status", params: { guildId, userId } },
    { action: "event-list", params: { guildId } },
  ];

  it.each(readActions)(
    "fences $action after lazy dispatch while preserving healthy reads",
    async (action) => {
      const authority = createAuthority();
      const context = { ...action, assertConversationReadAuthority: authority.assert };
      await expect(invoke(context)).resolves.toMatchObject({ details: { ok: true } });
      expect(fetchMock).toHaveBeenCalled();
      fetchMock.mockClear();

      const pending = invoke(context);
      authority.revoke();
      await expect(pending).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "rechecks after awaited channel metadata (revoked=%s)",
    async (revoked) => {
      const authority = createAuthority();
      const started = createDeferred<void>();
      const response = createDeferred<Response>();
      fetchMock.mockImplementationOnce(async () => {
        started.resolve();
        return await response.promise;
      });
      const pending = invoke({ assertConversationReadAuthority: authority.assert });
      const outcome = Promise.allSettled([pending]);
      await started.promise;
      if (revoked) {
        authority.revoke();
      }
      response.resolve(createJsonResponse(channel));
      const [result] = await outcome;
      expect(result.status).toBe(revoked ? "rejected" : "fulfilled");
      expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).toEqual(
        revoked ? [channelPath] : [channelPath, messagesPath],
      );
    },
  );

  it.each([
    { path: channelPath, revoked: true },
    { path: channelPath, revoked: false },
    { path: messagesPath, revoked: true },
    { path: messagesPath, revoked: false },
  ])("rechecks $path after 429 backoff (revoked=$revoked)", async ({ path, revoked }) => {
    vi.useFakeTimers();
    const authority = createAuthority();
    const rateLimited = createDeferred<void>();
    let attempts = 0;
    fetchMock.mockImplementation(async (input, init) => {
      if (requestPath(input) === path && ++attempts === 1) {
        rateLimited.resolve();
        return createJsonResponse(
          { message: "Rate limited", retry_after: 1, global: false },
          { status: 429 },
        );
      }
      return fixtureResponse(input, init);
    });
    const pending = invoke({ assertConversationReadAuthority: authority.assert });
    const outcome = Promise.allSettled([pending]);
    await rateLimited.promise;
    await vi.advanceTimersByTimeAsync(0);
    if (revoked) {
      authority.revoke();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const [result] = await outcome;
    expect(result.status).toBe(revoked ? "rejected" : "fulfilled");
    const paths = fetchMock.mock.calls.map(([input]) => requestPath(input));
    expect(paths).toEqual(
      path === channelPath
        ? revoked
          ? [channelPath]
          : [channelPath, channelPath, messagesPath]
        : revoked
          ? [channelPath, messagesPath]
          : [channelPath, messagesPath, messagesPath],
    );
  });

  it.each([false, true])(
    "retains each queued owner's authority (guarded worker=%s)",
    async (guardedWorker) => {
      const authority = createAuthority();
      const healthyAuthority = createAuthority();
      const response = createDeferred<Response>();
      fetchMock.mockImplementationOnce(async () => await response.promise);
      const rest = new RequestClient(token, { scheduler: { maxConcurrency: 1 } });
      vi.spyOn(runtime, "fetchChannelInfoDiscord").mockImplementation((id, opts) =>
        originalRuntime.fetchChannelInfoDiscord(id, { ...opts, rest }),
      );
      vi.spyOn(runtime, "readMessagesDiscord").mockImplementation((id, query, opts) =>
        originalRuntime.readMessagesDiscord(id, query, { ...opts, rest }),
      );
      const active = guardedWorker
        ? invoke({ assertConversationReadAuthority: authority.assert })
        : rest.get(channelPath);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const staleRead = invoke({ assertConversationReadAuthority: authority.assert });
      const healthyRead = invoke({ assertConversationReadAuthority: healthyAuthority.assert });
      const send = rest.post(messagesPath, { body: { content: "unrelated send" } });
      const outcome = Promise.allSettled([active, staleRead, healthyRead, send]);
      try {
        await vi.waitFor(() => expect(rest.queueSize).toBe(4));
        authority.revoke();
        response.resolve(createJsonResponse(channel));
        const results = await outcome;
        expect(results.map((result) => result.status)).toEqual([
          guardedWorker ? "rejected" : "fulfilled",
          "rejected",
          "fulfilled",
          "fulfilled",
        ]);
        expect(
          fetchMock.mock.calls.map(([input, init]) => [init?.method, requestPath(input)]),
        ).toEqual([
          ["GET", channelPath],
          ["POST", messagesPath],
          ["GET", channelPath],
          ["GET", messagesPath],
        ]);
      } finally {
        response.resolve(createJsonResponse(channel));
        rest.abortAllRequests();
        await outcome;
      }
    },
  );
});
