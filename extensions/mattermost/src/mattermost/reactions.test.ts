import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addMattermostReaction, removeMattermostReaction } from "./reactions.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
} from "./reactions.test-helpers.js";

const fetchFixture = await vi.hoisted(async () =>
  (await import("./fetch.test-support.js")).createMattermostFetchFixture(),
);
// mock-isolation: Preserve real exports while binding fetch to this suite's transport fixture.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", fetchFixture.mockRuntime);

let cfg: ReturnType<typeof createMattermostTestConfig>;
beforeEach(() => {
  cfg = createMattermostTestConfig();
});

afterEach(() => {
  vi.restoreAllMocks();
});

type ReactionOverrides = Partial<Parameters<typeof addMattermostReaction>[0]>;
const react = (overrides: ReactionOverrides = {}, action = addMattermostReaction) =>
  action({ cfg, postId: "POST1", emojiName: "thumbsup", ...overrides });
const operatorReaction = (action = addMattermostReaction, overrides: ReactionOverrides = {}) =>
  react({ conversationReadOrigin: "direct-operator", ...overrides }, action);
const delegatedReaction = (authorizedTarget: string, overrides: ReactionOverrides = {}) =>
  react({ authorizedTarget, conversationReadOrigin: "delegated", ...overrides });
const expectSuccess = async (result: ReturnType<typeof react>) =>
  expect(await result).toEqual({ ok: true });

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

  await expectSuccess(delegatedReaction("channel:CHANNEL1"));
  expect(requestedPaths(fetchMock)).toEqual([
    "/api/v4/posts/POST1",
    "/api/v4/users/me",
    "/api/v4/reactions",
  ]);
});

const foreignDm = { postChannelId: "DMCHANNEL", channelType: "D", channelName: "BOT123__OTHER123" };
it.each([
  [{ postChannelId: "CHANNEL2" }, "channel:CHANNEL1", "belongs to a different conversation", 1],
  [{ postChannelId: null }, "channel:CHANNEL1", "missing its conversation binding", 1],
  [
    { postChannelId: "CHANNEL1" },
    undefined,
    "require a canonical authorized conversation target",
    0,
  ],
  [foreignDm, "user:PEER123", "belongs to a different direct conversation", 3],
  [foreignDm, "user:BOT123", "belongs to a different direct conversation", 3],
] satisfies Array<[Parameters<typeof reactionFetch>[0], string | undefined, string, number]>)(
  "rejects unauthorized reaction %j / %s",
  async (fixture, authorizedTarget, error, calls) => {
    const fetchMock = reactionFetch(fixture);
    expect(
      await react({
        authorizedTarget,
        conversationReadOrigin: authorizedTarget ? "delegated" : undefined,
      }),
    ).toEqual({
      ok: false,
      error: expect.stringContaining(error),
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(requestedPaths(fetchMock)).not.toContain("/api/v4/reactions");
  },
);

it("binds delegated self-DM reactions without collapsing duplicate participant ids", async () => {
  reactionFetch({
    postChannelId: "DMCHANNEL",
    channelType: "D",
    channelName: "BOT123__BOT123",
  });

  await expectSuccess(delegatedReaction("user:BOT123"));
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

  const selectedConfig = createMattermostTestConfig();
  selectedConfig.channels!.mattermost!.accounts = { default: defaultAccount, work: workAccount };
  await expectSuccess(
    delegatedReaction("channel:CHANNEL1", { cfg: selectedConfig, accountId: "work" }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("preserves direct-operator crossed-post reactions without a provider metadata read", async () => {
  const fetchMock = reactionFetch();

  await expectSuccess(
    operatorReaction(addMattermostReaction, { authorizedTarget: "channel:DIFFERENT" }),
  );
  expect(requestedPaths(fetchMock)).toEqual(["/api/v4/users/me", "/api/v4/reactions"]);
});

it("returns a Result error when add reaction API call fails", async () => {
  reactionFetch({
    status: 500,
    body: { id: "err", message: "boom" },
  });

  expect(await operatorReaction()).toEqual({
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

  await expectSuccess(operatorReaction(removeMattermostReaction));
  expect(requestedPaths(fetchMock)).toEqual([
    "/api/v4/users/me",
    "/api/v4/users/BOT123/posts/POST1/reactions/thumbsup",
  ]);
});

it("caches the bot user id across reaction mutations", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const fetchMock = reactionFetch({ mode: "both" });
  await expectSuccess(operatorReaction());
  await expectSuccess(operatorReaction(removeMattermostReaction));
  expect(requestedPaths(fetchMock).filter((path) => path === "/api/v4/users/me")).toHaveLength(1);

  vi.mocked(Date.now).mockReturnValue(1_800_000_600_001);
  await expectSuccess(operatorReaction());
  expect(requestedPaths(fetchMock).filter((path) => path === "/api/v4/users/me")).toHaveLength(2);
});
