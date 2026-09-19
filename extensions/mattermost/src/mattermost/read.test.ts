import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createMattermostTestConfig } from "./reactions.test-helpers.js";
import { readMattermostMessages } from "./read.js";
import type { OpenClawConfig } from "./runtime-api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 403 ? "Forbidden" : "OK",
    headers: { "content-type": "application/json" },
  });
}

function createReadFetch(params?: { channelType?: string; postStatus?: number }) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = requestUrl(input);
    const channelMatch = url.match(/\/api\/v4\/channels\/([^/?]+)$/);
    if (channelMatch) {
      return jsonResponse({ id: channelMatch[1], type: params?.channelType ?? "O" });
    }
    if (url.includes("/api/v4/channels/") && url.includes("/posts?")) {
      if (params?.postStatus === 403) {
        return jsonResponse({ message: "You do not have the appropriate permissions." }, 403);
      }
      return jsonResponse({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", channel_id: "CURRENT", message: "older", create_at: 1_000 },
          "post-2": { id: "post-2", channel_id: "CURRENT", message: "newer", create_at: 2_000 },
        },
      });
    }
    throw new Error(`Unexpected Mattermost request: ${url}`);
  });
}

const HISTORY_POSTS = [
  { id: "current-old", channel_id: "CURRENT", message: "first", create_at: 1_000 },
  { id: "other-post", channel_id: "OTHER", message: "elsewhere", create_at: 1_500 },
  { id: "current-mid", channel_id: "CURRENT", message: "second", create_at: 2_000 },
  { id: "current-new", channel_id: "CURRENT", message: "latest", create_at: 3_000 },
];

// A channel whose posts all carry one create_at: `before`/`after` cursors skip
// the whole tied group, so only the page offset reaches past the first page.
const TIED_GROUP_SIZE = 61;
const TIED_POSTS = [
  { id: "current-newest", channel_id: "CURRENT", message: "anchor", create_at: 3_000 },
  ...Array.from({ length: TIED_GROUP_SIZE }, (_, index) => ({
    id: `current-tied-${index}`,
    channel_id: "CURRENT",
    message: `tied ${index}`,
    create_at: 2_000,
  })),
  { id: "current-oldest", channel_id: "CURRENT", message: "older", create_at: 1_000 },
];
// The last member of the group falls outside the default 60-post page.
const TIED_SECOND_PAGE_POST = TIED_POSTS[TIED_GROUP_SIZE] as (typeof TIED_POSTS)[number];
// Without the anchor the tied group carries the channel's newest create_at.
const TIED_NEWEST_POSTS = TIED_POSTS.filter((post) => post.id !== "current-newest");

// Mirrors Mattermost's channel post cursors: `before`/`after` compare create_at
// with the cursor post from any channel but return only the requested channel's
// posts, newest first, offset by `page` pages of `per_page`. Any other endpoint,
// including GET /posts/{id}, fails.
function createChannelHistoryFetch(posts: typeof HISTORY_POSTS = HISTORY_POSTS) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    const match = url.pathname.match(/^\/api\/v4\/channels\/([^/]+)(\/posts)?$/);
    if (!match) {
      throw new Error(`Unexpected Mattermost request: ${url.toString()}`);
    }
    if (!match[2]) {
      return jsonResponse({ id: match[1], type: "O" });
    }
    const after = url.searchParams.get("after");
    const cursorId = after ?? url.searchParams.get("before");
    const cursorAt = posts.find((post) => post.id === cursorId)?.create_at;
    const perPage = Number(url.searchParams.get("per_page"));
    const offset = Number(url.searchParams.get("page") ?? 0) * perPage;
    const page = posts
      .filter(
        (post) =>
          post.channel_id === match[1] &&
          (!cursorId ||
            (cursorAt !== undefined &&
              (after ? post.create_at > cursorAt : post.create_at < cursorAt))),
      )
      .toSorted((a, b) => (after ? a.create_at - b.create_at : b.create_at - a.create_at))
      .slice(offset, offset + perPage)
      .toSorted((a, b) => b.create_at - a.create_at);
    return jsonResponse({
      order: page.map((post) => post.id),
      posts: Object.fromEntries(page.map((post) => [post.id, post])),
    });
  });
}

function requestPaths(fetchImpl: ReturnType<typeof createChannelHistoryFetch>): string[] {
  return fetchImpl.mock.calls.map(([input]) => new URL(requestUrl(input)).pathname);
}

// `<cursor direction>:<page offset>` for each channel-history request.
function postRequestPages(fetchImpl: ReturnType<typeof createChannelHistoryFetch>): string[] {
  return fetchImpl.mock.calls
    .map(([input]) => new URL(requestUrl(input)))
    .filter((url) => url.pathname.endsWith("/posts"))
    .map(
      (url) =>
        `${url.searchParams.get("after") ? "after" : "before"}:${url.searchParams.get("page") ?? "default"}`,
    );
}

function delegatedContext(currentChannelId = "channel:CURRENT") {
  return {
    conversationReadOrigin: "delegated" as const,
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "mattermost",
      currentChannelId,
    },
  };
}

describe("readMattermostMessages", () => {
  it("reads the exact current conversation without a metadata round trip", async () => {
    const fetchImpl = createReadFetch();

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-current"),
      channelId: "CURRENT",
      limit: 2,
      accountId: "default",
      context: delegatedContext(),
      fetchImpl,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["post-2", "post-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain("/channels/CURRENT/posts?per_page=2");
  });

  it("allows a configured delegated cross-channel read", async () => {
    const cfg = createMattermostTestConfig("read-configured") as OpenClawConfig;
    cfg.channels!.mattermost!.groupPolicy = "allowlist";
    cfg.channels!.mattermost!.groups = { OTHER: { requireMention: false } };
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("allows an unlisted member channel only when groupPolicy is open", async () => {
    const cfg = createMattermostTestConfig("read-open") as OpenClawConfig;
    cfg.channels!.mattermost!.groupPolicy = "open";
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
  });

  it.each([
    {
      label: "open policy",
      providerConfig: { groupPolicy: "open" as const },
    },
    {
      label: "allowlisted groups",
      providerConfig: {
        groupPolicy: "allowlist" as const,
        groups: { OTHER: { requireMention: false } },
      },
    },
  ])("inherits provider-level $label for a named account", async ({ providerConfig }) => {
    const cfg = createMattermostTestConfig("read-named-inheritance") as OpenClawConfig;
    Object.assign(cfg.channels!.mattermost!, providerConfig, {
      accounts: { work: { enabled: true } },
    });
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "OTHER",
        accountId: "work",
        context: {
          ...delegatedContext(),
          requesterAccountId: "work",
        },
        fetchImpl,
      }),
    ).resolves.toMatchObject({ messages: [{ id: "post-2" }, { id: "post-1" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("denies unconfigured and direct-message cross-channel targets before reading posts", async () => {
    for (const channelType of ["O", "D"]) {
      const fetchImpl = createReadFetch({ channelType });
      await expect(
        readMattermostMessages({
          cfg: createMattermostTestConfig(`read-denied-${channelType}`),
          channelId: "OTHER",
          accountId: "default",
          context: delegatedContext(),
          fetchImpl,
        }),
      ).rejects.toThrow("Mattermost read target channel is not allowed");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects delegated account switching before provider access", async () => {
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-account-switch"),
        channelId: "OTHER",
        accountId: "default",
        context: {
          ...delegatedContext(),
          requesterAccountId: "other-account",
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost delegated reads require the current Mattermost account");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the trusted native channel ID for the current DM", async () => {
    const fetchImpl = createReadFetch();

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-current-dm"),
      channelId: "CURRENT",
      accountId: "default",
      context: {
        ...delegatedContext(),
        toolContext: {
          currentChannelProvider: "mattermost",
          currentChannelId: "channel:CURRENT",
          currentMessagingTarget: "user:PEER",
        },
      },
      fetchImpl,
    });

    expect(result.messages.map((message) => message.id)).toEqual(["post-2", "post-1"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchImpl.mock.calls[0]![0])).toContain("/channels/CURRENT/posts?");
  });

  it("fails closed when the trusted native channel ID names another conversation", async () => {
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-conflicting-current"),
        channelId: "CURRENT",
        accountId: "default",
        context: {
          ...delegatedContext(),
          toolContext: {
            currentChannelProvider: "mattermost",
            currentChannelId: "channel:OTHER",
            currentMessagingTarget: "channel:CURRENT",
          },
        },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read target channel is not allowed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("lets a direct operator rely on Mattermost membership and preserves 403 errors", async () => {
    const fetchImpl = createReadFetch({ postStatus: 403 });

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-forbidden"),
        channelId: "OTHER",
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost API 403 Forbidden: You do not have the appropriate permissions.");
  });

  it.each(["current-old", "current-mid", "current-new"])(
    "reads exact post %s through the target channel history",
    async (messageId) => {
      const fetchImpl = createChannelHistoryFetch();

      const result = await readMattermostMessages({
        cfg: createMattermostTestConfig(`read-exact-${messageId}`),
        channelId: "CURRENT",
        messageId,
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      });

      expect(result).toEqual({
        messages: [HISTORY_POSTS.find((post) => post.id === messageId)],
        hasMore: false,
      });
      expect(requestPaths(fetchImpl)).toEqual(Array(2).fill("/api/v4/channels/CURRENT/posts"));
    },
  );

  it("reads an exact post that a full timestamp group pushed off the first page", async () => {
    const fetchImpl = createChannelHistoryFetch(TIED_POSTS);

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-exact-tied"),
      channelId: "CURRENT",
      messageId: TIED_SECOND_PAGE_POST.id,
      accountId: "default",
      context: delegatedContext(),
      fetchImpl,
    });

    expect(result).toEqual({ messages: [TIED_SECOND_PAGE_POST], hasMore: false });
    expect(postRequestPages(fetchImpl)).toEqual(["after:default", "before:default", "before:1"]);
  });

  it("reads an exact post from a timestamp group with no newer anchor", async () => {
    const fetchImpl = createChannelHistoryFetch(TIED_NEWEST_POSTS);

    const result = await readMattermostMessages({
      cfg: createMattermostTestConfig("read-exact-tied-newest"),
      channelId: "CURRENT",
      messageId: TIED_SECOND_PAGE_POST.id,
      accountId: "default",
      context: delegatedContext(),
      fetchImpl,
    });

    expect(result).toEqual({ messages: [TIED_SECOND_PAGE_POST], hasMore: false });
    expect(postRequestPages(fetchImpl)).toEqual(["after:default", "before:default", "before:1"]);
  });

  it("stops paging a timestamp group once an older post proves the read missing", async () => {
    const fetchImpl = createChannelHistoryFetch(TIED_NEWEST_POSTS);

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-exact-tied-missing"),
        channelId: "CURRENT",
        messageId: "current-absent",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read post was not found in the target channel");
    expect(postRequestPages(fetchImpl)).toEqual(["after:default", "before:default", "before:1"]);
  });

  it("rejects an exact read of a post from another channel without fetching it", async () => {
    const fetchImpl = createChannelHistoryFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-exact-other-channel"),
        channelId: "CURRENT",
        messageId: "other-post",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read post was not found in the target channel");
    expect(requestPaths(fetchImpl)).toEqual(Array(2).fill("/api/v4/channels/CURRENT/posts"));
  });

  it("fails an exact read of a missing post instead of returning history", async () => {
    const fetchImpl = createChannelHistoryFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-exact-missing"),
        channelId: "CURRENT",
        messageId: "missing-post",
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read post was not found in the target channel");
  });

  it("denies an exact read of an unconfigured channel before reading posts", async () => {
    const fetchImpl = createChannelHistoryFetch();

    await expect(
      readMattermostMessages({
        cfg: createMattermostTestConfig("read-exact-denied"),
        channelId: "OTHER",
        messageId: "other-post",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).rejects.toThrow("Mattermost read target channel is not allowed");
    expect(requestPaths(fetchImpl)).toEqual(["/api/v4/channels/OTHER"]);
  });

  it("rejects disabled accounts before provider access", async () => {
    const cfg = createMattermostTestConfig("read-disabled") as OpenClawConfig;
    cfg.channels!.mattermost!.enabled = false;
    const fetchImpl = createReadFetch();

    await expect(
      readMattermostMessages({
        cfg,
        channelId: "CURRENT",
        accountId: "default",
        context: delegatedContext(),
        fetchImpl,
      }),
    ).rejects.toThrow('Mattermost account "default" is disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
