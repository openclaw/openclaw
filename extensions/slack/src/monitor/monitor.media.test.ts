import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackThreadStarter } from "./thread.js";

type ResolveSlackThreadStarterParams = Parameters<typeof resolveSlackThreadStarter>[0];
type ThreadStarterClient = ResolveSlackThreadStarterParams["client"];

let testWorkspaceSequence = 0;
let testWorkspaceScope = { accountId: "test-0", teamId: "T0" };

function resolveTestSlackThreadStarter(
  client: ThreadStarterClient,
  overrides: Partial<Omit<ResolveSlackThreadStarterParams, "client">> = {},
) {
  return resolveSlackThreadStarter({
    channelId: "C1",
    threadTs: "1000.1",
    workspaceScope: testWorkspaceScope,
    client,
    ...overrides,
  });
}

function createThreadStarterRepliesClient(text = "root message") {
  const replies = vi.fn(async () => ({ messages: [{ text }] }));
  const client = {
    conversations: { replies },
  } as unknown as ThreadStarterClient;
  return { replies, client };
}

describe("resolveSlackThreadStarter cache", () => {
  beforeEach(() => {
    testWorkspaceSequence += 1;
    testWorkspaceScope = {
      accountId: `test-${testWorkspaceSequence}`,
      teamId: `T${testWorkspaceSequence}`,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches within ttl and isolates the same channel and thread across Slack accounts", async () => {
    const teamOne = createThreadStarterRepliesClient("team one root");
    const teamTwo = createThreadStarterRepliesClient("team two root");

    const scopeOne = { workspaceScope: { accountId: "account-one", teamId: "T1" } };
    const scopeTwo = { workspaceScope: { accountId: "account-two", teamId: "T2" } };
    const first = await resolveTestSlackThreadStarter(teamOne.client, scopeOne);
    const second = await resolveTestSlackThreadStarter(teamTwo.client, scopeTwo);
    const cachedFirst = await resolveTestSlackThreadStarter(teamOne.client, scopeOne);

    expect(first?.text).toBe("team one root");
    expect(second?.text).toBe("team two root");
    expect(cachedFirst).toEqual(first);
    expect(teamOne.replies).toHaveBeenCalledTimes(1);
    expect(teamTwo.replies).toHaveBeenCalledTimes(1);
  });

  it("expires stale cache entries and refetches after ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const { replies, client } = createThreadStarterRepliesClient();

    await resolveTestSlackThreadStarter(client);

    vi.setSystemTime(new Date("2026-01-01T07:00:00.000Z"));
    await resolveTestSlackThreadStarter(client);

    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("does not cache empty starter text", async () => {
    const { replies, client } = createThreadStarterRepliesClient("   ");

    const first = await resolveTestSlackThreadStarter(client);
    const second = await resolveTestSlackThreadStarter(client);

    expect([first, second]).toEqual([null, null]);
    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries once cache exceeds bounded size", async () => {
    const { replies, client } = createThreadStarterRepliesClient();

    for (let i = 0; i <= 2000; i += 1) {
      await resolveTestSlackThreadStarter(client, { threadTs: `1000.${i}` });
    }
    const callsAfterFill = replies.mock.calls.length;

    await resolveTestSlackThreadStarter(client, { threadTs: "1000.0" });

    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
