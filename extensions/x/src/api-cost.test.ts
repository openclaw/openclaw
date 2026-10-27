import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { XBudgetExceededError } from "./spend.js";
import { createXTestApi as createXApiClient, type XFetch } from "./test-support/api-client.js";
import { createXTestSpend } from "./test-support/spend.js";

const post = { id: "11", text: "Hello", author_id: "7", conversation_id: "11" };
const notDispatched = { code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED", retryable: false };
const reply = (api: ReturnType<typeof client>, text = "Reply") =>
  api.reply({ text, inReplyToId: "11" });
const refused = (call: Promise<unknown>) =>
  expect(call).rejects.toBeInstanceOf(XBudgetExceededError);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-10-19T12:00:00Z");
});
afterEach(() => vi.useRealTimers());

function client(fetch: XFetch, dailyUsd = 100, spend = createXTestSpend({ dailyUsd })) {
  const request = vi.fn(fetch);
  const api = createXApiClient({
    spend,
    bearerToken: "synthetic",
    fetch: (input, init) =>
      input.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "synthetic" }))
        : request(input, init),
  });
  return Object.assign(api, { request });
}

async function expectSpent(api: ReturnType<typeof client>, usd: number) {
  expect(await api.spend.status()).toMatchObject({ dayUsd: usd, cycleUsd: usd });
}

it("reserves the whole username batch, then charges only the users returned", async () => {
  const users = [
    { id: "7", username: "a", name: "A" },
    { id: "8", username: "b" },
  ];
  const api = client(async (url) => {
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/2/users/by");
    expect(parsed.searchParams.get("usernames")).toBe("a,b,missing");
    return Response.json({ data: users, errors: [{ resource_id: "missing" }] });
  }, 0.03);
  await expect(api.getUsersByUsernames(["@a", "b", "missing"])).resolves.toEqual(users);
  await expectSpent(api, 0.02);
  await refused(api.getUsersByUsernames(["a", "b"]));
  expect(api.request).toHaveBeenCalledOnce();
});

it.each([
  { label: "empty", usernames: [] },
  { label: "oversized", usernames: Array.from({ length: 101 }, (_, index) => `user${index}`) },
  { label: "comma-separated handle", usernames: ["alice,bob"] },
])("rejects $label usernames before spending or dispatch", async ({ usernames }) => {
  const api = client(async () => {
    throw new Error("Unexpected request");
  });
  await expect(api.getUsersByUsernames(usernames)).rejects.toThrow("1–100 valid usernames");
  await expectSpent(api, 0);
  expect(api.request).not.toHaveBeenCalled();
});

it("keeps reloaded-ledger budget refusals non-retryable", async () => {
  vi.resetModules();
  const { createXTestSpend: reloadedSpend } = await import("./test-support/spend.js");
  const api = client(
    async () => {
      throw new Error("Unexpected request");
    },
    0,
    reloadedSpend({ dailyUsd: 0 }),
  );
  await refused(api.getMentions({ userId: "9" }));
  await refused(api.getUserByUsername("author"));
  const rejected = reply(api);
  await expect(rejected).rejects.toMatchObject(notDispatched);
  await expect(rejected).rejects.toBeInstanceOf(PlatformMessageNotDispatchedError);
  expect(api.request).not.toHaveBeenCalled();
});

it("keeps subscription management free", async () => {
  const body = { data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }] };
  const api = client(async () => Response.json(body), 0);
  await api.ensureActivitySubscriptions("9");
  expect(api.request).toHaveBeenCalledOnce();
});

it.each([
  ["Visit https://example.com", 0.2],
  ["Visit example.com", 0.2],
  ["Contact person@example.com", 0.02],
] as const)("prices replies before competing dispatch: %s", async (text, cost) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const api = client(async (_url, init) => {
    if (init?.method === "POST") {
      entered.resolve();
      await release.promise;
      return Response.json({ data: { id: "21" } });
    }
    return Response.json({ data: [] });
  }, cost);
  await api.getPosts(["11"]);
  await expectSpent(api, 0);
  const first = reply(api, text);
  await entered.promise;
  try {
    await expect(reply(api, "Another reply")).rejects.toMatchObject({
      ...notDispatched,
      message: expect.stringContaining("daily budget"),
    });
    expect(api.request).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await first;
  }
  await expectSpent(api, cost);
});

it.each([
  [2, "10"],
  [37, "37"],
  [200, "100"],
] as const)("bounds search %s and bills expanded resources", async (maxPosts, expected) => {
  const user = { id: "7", username: "author" };
  const page = { data: [post], includes: { tweets: [{ ...post, id: "10" }], users: [user] } };
  const api = client(async (url) => {
    const query = new URL(url).searchParams;
    if (url.includes("/search/")) {
      expect([query.get("max_results"), query.get("expansions")]).toEqual([expected, "author_id"]);
    }
    return Response.json(url.includes("/users/by/") ? { data: user } : page);
  });
  await api.getPosts(["11", "10"]);
  await api.getPosts(["11", "10"]);
  await api.searchConversation({ conversationId: "11", maxPosts });
  await api.getUserByUsername("author");
  await expectSpent(api, 0.07);
  expect(api.request).toHaveBeenCalledTimes(4);
});

it.each([
  ["empty 4xx", Response.json({}, { status: 403 }), 0, false],
  ["4xx resources", Response.json({ data: [post, post] }, { status: 403 }), 0.01, false],
  ["5xx", Response.json({}, { status: 503 }), 0.15, false],
  ["unreadable JSON", new Response("invalid JSON"), 0.15, false],
  ["invalid page", Response.json({ data: "invalid" }), 0.15, false],
  ["null user", Response.json(null), 0.01, true],
  ["missing user", Response.json({}), 0, true],
] as const)("settles %s conservatively", async (_label, response, spent, userLookup) => {
  const api = client(async () => response, userLookup ? 0.01 : 100);
  const read = () =>
    userLookup ? api.getUserByUsername("author") : api.getMentions({ userId: "9" });
  await expect(read()).rejects.toThrow(userLookup ? "X API" : undefined);
  await expectSpent(api, spent);
  if (userLookup && spent) {
    await refused(read());
    expect(api.request).toHaveBeenCalledOnce();
  }
});
