import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addMattermostReaction, removeMattermostReaction } from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
} from "./reactions.test-helpers.js";

const fetchFixture = vi.hoisted((): { current: typeof fetch } => ({
  current: vi.fn<typeof fetch>(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      params.beforeRequest?.();
      return {
        response: await fetchFixture.current(params.url, params.init),
        release: async () => {},
      };
    },
  };
});

let cacheKeySequence = 0;
let cacheKey = "";

beforeEach(() => {
  cacheKey = String(++cacheKeySequence);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function reactionParams(overrides: Partial<Parameters<typeof addMattermostReaction>[0]> = {}) {
  return {
    cfg: createMattermostTestConfig(cacheKey),
    postId: "POST1",
    emojiName: "thumbsup",
    ...overrides,
  };
}

const addReaction = (overrides: Parameters<typeof reactionParams>[0] = {}) =>
  addMattermostReaction(reactionParams(overrides));
const delegatedReaction = (
  authorizedTarget: string,
  overrides: Parameters<typeof reactionParams>[0] = {},
) => addReaction({ authorizedTarget, conversationReadOrigin: "delegated", ...overrides });
const removeReaction = (overrides: Parameters<typeof reactionParams>[0] = {}) =>
  removeMattermostReaction(reactionParams(overrides));

function reactionFetch(
  overrides: Partial<Parameters<typeof createMattermostReactionFetchMock>[0]> = {},
) {
  return (fetchFixture.current = createMattermostReactionFetchMock({
    mode: "add",
    postId: "POST1",
    emojiName: "thumbsup",
    ...overrides,
  }));
}

function requestedPaths(fetchMock: ReturnType<typeof createMattermostReactionFetchMock>) {
  return fetchMock.mock.calls.map(([url]) => new URL(requestUrl(url)).pathname);
}

it("binds delegated reactions to the authorized channel before mutation", async () => {
  const fetchMock = reactionFetch({ postChannelId: "CHANNEL1" });

  expect(await delegatedReaction("channel:CHANNEL1")).toEqual({ ok: true });
  expect(requestedPaths(fetchMock)).toEqual([
    "/api/v4/posts/POST1",
    "/api/v4/users/me",
    "/api/v4/reactions",
  ]);
});

it.each<[string | null, string]>([
  ["CHANNEL2", "belongs to a different conversation"],
  [null, "missing its conversation binding"],
])("rejects invalid delegated post binding %s", async (postChannelId, error) => {
  const fetchMock = reactionFetch({ postChannelId });
  expect(await delegatedReaction("channel:CHANNEL1")).toEqual({
    ok: false,
    error: expect.stringContaining(error),
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("fails closed for an unspecified origin without a canonical target", async () => {
  const fetchMock = reactionFetch({ postChannelId: "CHANNEL1" });

  expect(await addReaction()).toEqual({
    ok: false,
    error: expect.stringContaining("require a canonical authorized conversation target"),
  });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["PEER123", "BOT123"])(
  "rejects another peer's DM for delegated target %s",
  async (target) => {
    const fetchMock = reactionFetch({
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__OTHER123",
    });
    expect(await delegatedReaction(`user:${target}`)).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different direct conversation"),
    });
    expect(requestedPaths(fetchMock)).not.toContain("/api/v4/reactions");
  },
);

it("binds delegated self-DM reactions without collapsing duplicate participant ids", async () => {
  reactionFetch({
    postChannelId: "DMCHANNEL",
    channelType: "D",
    channelName: "BOT123__BOT123",
  });

  expect(await delegatedReaction("user:BOT123")).toEqual({ ok: true });
});

it("uses the selected account for delegated binding and mutation", async () => {
  const defaultAccount = createMattermostTestConfig("default-account").channels?.mattermost;
  const workAccount = createMattermostTestConfig("work-account").channels?.mattermost;
  if (!defaultAccount || !workAccount) {
    throw new Error("expected Mattermost account fixtures");
  }
  const innerFetch = reactionFetch({ postChannelId: "CHANNEL1" });
  const fetchMock = (fetchFixture.current = vi.fn<typeof fetch>(async (url, init) => {
    expect(requestUrl(url)).toContain("https://work-account.chat.example.com/api/v4/");
    return await innerFetch(url, init);
  }));

  const result = await addReaction({
    cfg: {
      channels: {
        mattermost: {
          enabled: true,
          accounts: { default: defaultAccount, work: workAccount },
        },
      },
    },
    accountId: "work",
    authorizedTarget: "channel:CHANNEL1",
    conversationReadOrigin: "delegated",
  });

  expect(result).toEqual({ ok: true });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("preserves direct-operator crossed-post reactions without a provider metadata read", async () => {
  const fetchMock = reactionFetch();

  const result = await addReaction({
    authorizedTarget: "channel:DIFFERENT",
    conversationReadOrigin: "direct-operator",
  });

  expect(result).toEqual({ ok: true });
  expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
    expect.stringMatching(/\/api\/v4\/users\/me$/),
    expect.stringMatching(/\/api\/v4\/reactions$/),
  ]);
});

it("returns a Result error when add reaction API call fails", async () => {
  reactionFetch({
    status: 500,
    body: { id: "err", message: "boom" },
  });

  expect(await addReaction({ conversationReadOrigin: "direct-operator" })).toEqual({
    ok: false,
    error: expect.stringContaining("Mattermost add reaction failed"),
  });
});

it("reports an accepted removal as success when its 200 body cannot be read", async () => {
  const fetchMock = (fetchFixture.current = vi.fn<typeof fetch>(async (url, init) => {
    if (requestUrl(url).endsWith("/api/v4/users/me")) {
      return Response.json({ id: "BOT123" });
    }
    expect(init?.method).toBe("DELETE");
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError("terminated");
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  }));

  expect(await removeReaction({ conversationReadOrigin: "direct-operator" })).toEqual({ ok: true });
  expect(requestedPaths(fetchMock)).toEqual([
    "/api/v4/users/me",
    "/api/v4/users/BOT123/posts/POST1/reactions/thumbsup",
  ]);
});

it("caches the bot user id across reaction mutations", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const fetchMock = reactionFetch({
    mode: "both",
  });

  const cfg = createMattermostTestConfig(cacheKey);
  expect(await addReaction({ cfg, conversationReadOrigin: "direct-operator" })).toEqual({
    ok: true,
  });
  expect(await removeReaction({ cfg, conversationReadOrigin: "direct-operator" })).toEqual({
    ok: true,
  });
  expect(requestedPaths(fetchMock).filter((path) => path === "/api/v4/users/me")).toHaveLength(1);

  vi.mocked(Date.now).mockReturnValue(1_800_000_600_001);
  await expect(addReaction({ cfg, conversationReadOrigin: "direct-operator" })).resolves.toEqual({
    ok: true,
  });
  expect(requestedPaths(fetchMock).filter((path) => path === "/api/v4/users/me")).toHaveLength(2);
});
