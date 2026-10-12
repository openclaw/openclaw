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

    const result = await resolveSlackChannelAllowlist({
      token: fixture,
      entries: ["#does-not-exist"],
    });

    expect(result).toEqual([{ input: "#does-not-exist", resolved: false }]);
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
      entries: ["C01CU3R54A1", "channel:G0AFBKXS3CP", "<#C0AG61APJ3B|general>"],
      client: { conversations: { list } } as never,
    });

    expect(res.map((entry) => entry.id)).toEqual(["C01CU3R54A1", "G0AFBKXS3CP", "C0AG61APJ3B"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps canonical uppercase ids with a letter second character as ids", async () => {
    const list = vi.fn();
    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["CA1234567", "channel:GA1234567", "slack:CABCDEFGH"],
      client: { conversations: { list } } as never,
    });

    expect(res.map((entry) => entry.id)).toEqual(["CA1234567", "GA1234567", "CABCDEFGH"]);
    expect(list).not.toHaveBeenCalled();
  });

  it("does not misclassify a bare channel name starting with c/g as an id (#155820)", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: "C0AG61APJ3B", name: "general", is_archived: false },
            { id: "C01234567", name: "c0ag61apj3b", is_archived: false },
          ],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["general", "c0ag61apj3b", "#c0ag61apj3b"],
      client: client as never,
    });

    expect(client.conversations.list).toHaveBeenCalledOnce();
    expect(res[0]).toEqual({
      input: "general",
      resolved: true,
      id: "C0AG61APJ3B",
      name: "general",
      archived: false,
    });
    expect(res[1]).toMatchObject({ resolved: true, id: "C0AG61APJ3B" });
    expect(res[2]).toMatchObject({ resolved: true, id: "C01234567" });
  });

  it("keeps folded letter-second ids as ids when a namesake channel exists", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({
          channels: [
            { id: "C0AG61APJ3B", name: "general", is_archived: false },
            { id: "C09876543", name: "ca1234567", is_archived: false },
          ],
        }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["general", "ca1234567", "channel:ga1234567", "#ca1234567"],
      client: client as never,
    });

    expect(res.map((entry) => entry.id)).toEqual([
      "C0AG61APJ3B",
      "CA1234567",
      "GA1234567",
      "C09876543",
    ]);
  });

  it("keeps a Slack DM conversation id unresolved instead of accepting it as a channel id", async () => {
    const client = {
      conversations: {
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };

    const res = await resolveSlackChannelAllowlist({
      token: "xoxb-test",
      entries: ["D0AFBKXS3CP"],
      client: client as never,
    });

    expect(res[0]?.resolved).toBe(false);
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
});
