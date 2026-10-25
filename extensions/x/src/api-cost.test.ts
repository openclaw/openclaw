import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XBudgetExceededError } from "./spend.js";
import { createXTestApi as createXApiClient, type XFetch } from "./test-support/api-client.js";
import { createXTestSpend } from "./test-support/spend.js";

const post = { id: "11", text: "Hello", author_id: "7", conversation_id: "11" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-19T12:00:00Z");
});
afterEach(() => vi.useRealTimers());

function client(fetch: XFetch, dailyUsd = 100, spend = createXTestSpend({ dailyUsd })) {
  return createXApiClient({
    spend,
    clientId: "synthetic",
    clientSecret: "synthetic",
    refreshToken: "synthetic",
    bearerToken: "synthetic",
    saveRefreshToken: async () => {},
    fetch: (input, init) =>
      input.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "synthetic" }))
        : fetch(input, init),
  });
}

async function expectSpent(api: ReturnType<typeof client>, usd: number) {
  expect(await api.spend.status()).toMatchObject({ dayUsd: usd, cycleUsd: usd });
}

describe("X paid request budget boundary", () => {
  it("reserves the whole username batch, then charges only the users returned", async () => {
    const users = [
      { id: "7", username: "alice", name: "Alice" },
      { id: "8", username: "bob" },
    ];
    const fetch = vi.fn<XFetch>(async (url) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/2/users/by");
      expect(parsed.searchParams.get("usernames")).toBe("alice,bob,missing");
      return Response.json({ data: users, errors: [{ resource_id: "missing" }] });
    });
    const api = client(fetch, 0.03);
    await expect(api.getUsersByUsernames(["@alice", "bob", "missing"])).resolves.toEqual(users);
    await expectSpent(api, 0.02);
    await expect(api.getUsersByUsernames(["alice", "bob"])).rejects.toBeInstanceOf(
      XBudgetExceededError,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "empty", usernames: [] },
    { label: "oversized", usernames: Array.from({ length: 101 }, (_, index) => `user${index}`) },
    { label: "comma-separated handle", usernames: ["alice,bob"] },
    { label: "overlong handle", usernames: ["x".repeat(16)] },
  ])("rejects $label usernames before spending or dispatch", async ({ usernames }) => {
    const fetch = vi.fn<XFetch>();
    const api = client(fetch);
    await expect(api.getUsersByUsernames(usernames)).rejects.toThrow("1–100 valid usernames");
    await expectSpent(api, 0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps budget refusals non-retryable across separately loaded ledger modules", async () => {
    vi.resetModules();
    const { createXTestSpend: reloadedSpend } = await import("./test-support/spend.js");
    const fetch = vi.fn<XFetch>();
    const api = client(fetch, 0, reloadedSpend({ dailyUsd: 0 }));
    await expect(api.reply({ text: "Reply", inReplyToId: "11" })).rejects.toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a competing reply before dispatch and releases empty reads for later calls", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetch = vi.fn<XFetch>(async (_url, init) => {
      if (init?.method === "POST") {
        entered.resolve();
        await release.promise;
        return Response.json({ data: { id: "21" } });
      }
      return Response.json({ data: [] });
    });
    const api = client(fetch, 0.02);
    await api.getPosts(["11"]);
    await expectSpent(api, 0);
    const first = api.reply({ text: "Plain reply", inReplyToId: "11" });
    await entered.promise;
    try {
      await expect(api.reply({ text: "Another reply", inReplyToId: "11" })).rejects.toMatchObject({
        code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
        retryable: false,
        message: expect.stringContaining("daily budget"),
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await first;
    }
    await expectSpent(api, 0.02);
  });

  it("counts returned posts, included posts and users, and lookups without deduplication", async () => {
    const user = { id: "7", username: "author" };
    const page = { data: [post], includes: { tweets: [{ ...post, id: "10" }], users: [user] } };
    const api = client(async (url) =>
      Response.json(url.includes("/users/by/") ? { data: user } : page),
    );
    await api.getPosts(["11", "10"]);
    await api.getPosts(["11", "10"]);
    await api.getUserByUsername("author");
    await expectSpent(api, 0.05);
  });

  it.each([
    ["explicit empty 4xx", () => Response.json({}, { status: 403 }), 0],
    [
      "4xx with resources",
      () => Response.json({ data: [post, { ...post, id: "12" }] }, { status: 403 }),
      0.01,
    ],
    ["5xx", () => Response.json({}, { status: 503 }), 0.15],
    ["unparseable success", () => new Response("invalid JSON"), 0.15],
    ["invalid success payload", () => Response.json({ data: "invalid" }), 0.15],
  ] as const)("settles %s conservatively", async (_label, response, spent) => {
    const api = client(async () => response());
    await expect(api.getMentions({ userId: "9" })).rejects.toThrow();
    await expectSpent(api, spent);
  });

  it.each([
    ["null", null, 0.01],
    ["string", "invalid", 0.01],
    ["array", [], 0.01],
    ["empty resource", {}, 0],
  ] as const)("settles a %s username envelope conservatively", async (_label, body, spent) => {
    const fetch = vi.fn<XFetch>(async () => Response.json(body));
    const api = client(fetch, 0.01);
    await expect(api.getUserByUsername("author")).rejects.toThrow("X API");
    await expectSpent(api, spent);
    if (spent) {
      await expect(api.getUserByUsername("author")).rejects.toBeInstanceOf(XBudgetExceededError);
      expect(fetch).toHaveBeenCalledOnce();
    }
  });

  it("does not dispatch paid calls with zero limits but leaves free subscription management available", async () => {
    const fetch = vi.fn<XFetch>(async () =>
      Response.json({ data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }] }),
    );
    const api = client(fetch, 0);
    await expect(api.getMentions({ userId: "9" })).rejects.toBeInstanceOf(XBudgetExceededError);
    await expect(api.getUserByUsername("author")).rejects.toBeInstanceOf(XBudgetExceededError);
    await expect(api.reply({ text: "Reply", inReplyToId: "11" })).rejects.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(fetch).not.toHaveBeenCalled();
    await api.ensureActivitySubscriptions("9");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["Plain text", 0.02],
    ["Visit https://example.com", 0.2],
    ["Visit example.com", 0.2],
    ["Contact person@example.com", 0.02],
  ] as const)("charges reply text '%s' using the URL detector", async (text, cost) => {
    const api = client(async () => Response.json({ data: { id: "21" } }));
    await api.reply({ text, inReplyToId: "11" });
    await expectSpent(api, cost);
  });

  it.each([
    [2, "10"],
    [37, "37"],
    [200, "100"],
  ])("bounds search results for %s context posts", async (maxPosts, expected) => {
    const fetch = vi.fn<XFetch>(async (url) => {
      const query = new URL(url).searchParams;
      expect(query.get("max_results")).toBe(expected);
      expect(query.get("expansions")).toBe("author_id");
      return Response.json({ data: [] });
    });
    await client(fetch).searchConversation({ conversationId: "11", maxPosts });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
