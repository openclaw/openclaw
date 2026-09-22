// Slack tests cover resolve channels plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";

const slackClientMocks = vi.hoisted(() => ({
  conversationsList: vi.fn(),
  createSlackLookupClient: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

describe("resolveSlackChannelAllowlist", () => {
  beforeEach(() => {
    slackClientMocks.conversationsList.mockReset();
    slackClientMocks.createSlackLookupClient.mockReset().mockReturnValue({
      conversations: { list: slackClientMocks.conversationsList },
    });
  });

  it("uses the bounded lookup client when no client is injected", async () => {
    const fixture = "lookup-fixture";
    slackClientMocks.conversationsList.mockResolvedValue({ channels: [] });

    await resolveSlackChannelAllowlist({
      token: fixture,
      entries: ["#does-not-exist"],
    });

    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledOnce();
    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledWith(fixture);
    expect(slackClientMocks.conversationsList).toHaveBeenCalledOnce();
    expect(slackClientMocks.conversationsList).toHaveBeenCalledWith({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor: undefined,
    });
  });

  it("returns stable channel ids without listing a workspace", async () => {
    const list = vi.fn();
    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["C123", "channel:G456", "<#C789|general>"],
      client: { conversations: { list } } as never,
    });

    expect(res.map((entry) => entry.id)).toEqual(["C123", "G456", "C789"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("preserves workspace-qualified channel ids without listing a workspace", async () => {
    const list = vi.fn();
    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["team:T11111111:channel:C01234567", "team:T22222222:channel:C01234567"],
      client: { conversations: { list } } as never,
    });

    expect(res.map((entry) => entry.id)).toEqual([
      "team:T11111111:channel:C01234567",
      "team:T22222222:channel:C01234567",
    ]);
    expect(list).not.toHaveBeenCalled();
  });

  it("resolves by name and prefers active channels", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: "C1", name: "general", is_archived: true },
            { id: "C2", name: "general", is_archived: false },
          ],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["#general"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(true);
    expect(res[0]?.id).toBe("C2");
  });

  it.each([
    { input: "TEAM:%5411111111:CHANNEL:%4301234567", resolved: true },
    { input: "team:T11111111:user:U01234567", resolved: false },
    { input: "team:T11111111:channel:%ZZ", resolved: false },
    { input: " team:T11111111:channel:C01234567", resolved: false },
  ])(
    "keeps qualified target ordering and lookup boundaries for $input",
    async ({ input, resolved }) => {
      slackClientMocks.conversationsList.mockResolvedValue({ channels: [] });
      const first = "team:T22222222:channel:C01234567";
      const last = "team:T33333333:channel:C01234567";

      const result = await resolveSlackChannelAllowlist({
        token: "lookup-fixture",
        entries: [first, input, last],
      });

      expect(result).toEqual([
        { input: first, resolved: true, id: first },
        resolved
          ? { input, resolved: true, id: "team:T11111111:channel:C01234567" }
          : { input, resolved: false },
        { input: last, resolved: true, id: last },
      ]);
      expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledTimes(resolved ? 0 : 1);
      expect(slackClientMocks.conversationsList).toHaveBeenCalledTimes(resolved ? 0 : 1);
    },
  );

  it("keeps unresolved entries", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["#does-not-exist"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(false);
  });
});
