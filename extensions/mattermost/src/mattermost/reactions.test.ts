import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("mattermost reactions", () => {
  let cacheKeySequence = 0;
  let cacheKey = "";

  beforeEach(() => {
    cacheKey = String(++cacheKeySequence);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function addReactionWithFetch(fetchMock: typeof fetch) {
    fetchFixture.current = fetchMock;
    return addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
    });
  }

  it("binds delegated reactions to the authorized channel before mutation", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringMatching(/\/api\/v4\/posts\/POST1$/),
      expect.stringMatching(/\/api\/v4\/users\/me$/),
      expect.stringMatching(/\/api\/v4\/reactions$/),
    ]);
  });

  it("rejects crossed delegated channel posts before bot lookup or mutation", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL2",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different conversation"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unspecified origin without a canonical target", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("require a canonical authorized conversation target"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects delegated direct-message posts owned by another peer", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__OTHER123",
      userId: "BOT123",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:PEER123",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different direct conversation"),
    });
    expect(
      fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/api/v4/reactions")),
    ).toBe(false);
  });

  it("binds delegated self-DM reactions without collapsing duplicate participant ids", async () => {
    fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__BOT123",
      userId: "BOT123",
      emojiName: "thumbsup",
    });

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:BOT123",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects another peer's DM when the delegated target is the bot itself", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "DMCHANNEL",
      channelType: "D",
      channelName: "BOT123__OTHER123",
      userId: "BOT123",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "user:BOT123",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("belongs to a different direct conversation"),
    });
    expect(
      fetchMock.mock.calls.some((call) => requestUrl(call[0]).endsWith("/api/v4/reactions")),
    ).toBe(false);
  });

  it("fails closed when delegated post metadata omits the provider channel", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: null,
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("missing its conversation binding"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the selected account for delegated binding and mutation", async () => {
    const defaultAccount = createMattermostTestConfig("default-account").channels?.mattermost;
    const workAccount = createMattermostTestConfig("work-account").channels?.mattermost;
    if (!defaultAccount || !workAccount) {
      throw new Error("expected Mattermost account fixtures");
    }
    const innerFetch = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      postChannelId: "CHANNEL1",
      emojiName: "thumbsup",
    });
    const fetchMock = (fetchFixture.current = vi.fn<typeof fetch>(async (url, init) => {
      expect(requestUrl(url)).toContain("https://work-account.chat.example.com/api/v4/");
      return await innerFetch(url, init);
    }));

    const result = await addMattermostReaction({
      cfg: {
        channels: {
          mattermost: {
            enabled: true,
            accounts: {
              default: defaultAccount,
              work: workAccount,
            },
          },
        },
      },
      accountId: "work",
      postId: "POST1",
      emojiName: "thumbsup",
      authorizedTarget: "channel:CHANNEL1",
      conversationReadOrigin: "delegated",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves direct-operator crossed-post reactions without a provider metadata read", async () => {
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
    }));

    const result = await addMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
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
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup",
      status: 500,
      body: { id: "err", message: "boom" },
    }));

    const result = await addReactionWithFetch(fetchMock);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Mattermost add reaction failed");
    }
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

    const result = await removeMattermostReaction({
      cfg: createMattermostTestConfig(cacheKey),
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      expect.stringMatching(/\/api\/v4\/users\/me$/),
      expect.stringMatching(/\/api\/v4\/users\/BOT123\/posts\/POST1\/reactions\/thumbsup$/),
    ]);
  });

  it("caches the bot user id across reaction mutations", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchMock = (fetchFixture.current = createMattermostReactionFetchMock({
      mode: "both",
      postId: "POST1",
      emojiName: "thumbsup",
    }));

    const cfg = createMattermostTestConfig(cacheKey);
    const addResult = await addMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
    });
    const removeResult = await removeMattermostReaction({
      cfg,
      postId: "POST1",
      emojiName: "thumbsup",
      conversationReadOrigin: "direct-operator",
    });

    const usersMeCalls = fetchMock.mock.calls.filter((call) =>
      requestUrl(call[0]).endsWith("/api/v4/users/me"),
    );
    expect(addResult).toEqual({ ok: true });
    expect(removeResult).toEqual({ ok: true });
    expect(usersMeCalls).toHaveLength(1);

    vi.mocked(Date.now).mockReturnValue(1_800_000_600_001);
    await expect(
      addMattermostReaction({
        cfg,
        postId: "POST1",
        emojiName: "thumbsup",
        conversationReadOrigin: "direct-operator",
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      fetchMock.mock.calls.filter((call) => requestUrl(call[0]).endsWith("/api/v4/users/me")),
    ).toHaveLength(2);
  });
});
