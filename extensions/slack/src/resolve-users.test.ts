// Slack tests cover resolve users plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

const slackClientMocks = vi.hoisted(() => ({
  createSlackLookupClient: vi.fn(),
  usersList: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

describe("resolveSlackUserAllowlist", () => {
  beforeEach(() => {
    slackClientMocks.usersList.mockReset();
    slackClientMocks.createSlackLookupClient.mockReset().mockReturnValue({
      users: { list: slackClientMocks.usersList },
    });
  });

  it("uses the bounded lookup client when no client is injected", async () => {
    const fixture = "lookup-fixture";
    slackClientMocks.usersList.mockResolvedValue({ members: [] });

    const result = await resolveSlackUserAllowlist({
      token: fixture,
      entries: ["@missing-user"],
    });

    expect(result).toEqual([{ input: "@missing-user", resolved: false }]);
    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledOnce();
    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledWith(fixture);
    expect(slackClientMocks.usersList).toHaveBeenCalledOnce();
  });

  it.each(["person@example.com", "@Person"])(
    "resolves %s by preferring active humans and retaining directory order on ties",
    async (input) => {
      const client = {
        users: {
          list: vi.fn().mockResolvedValue({
            members: [
              {
                id: "U1",
                name: "bot-user",
                is_bot: true,
                deleted: false,
                profile: { email: "person@example.com", display_name: "Person" },
              },
              {
                id: "U_DELETED",
                name: "deleted-person",
                deleted: true,
                profile: { email: "person@example.com", display_name: "Person" },
              },
              {
                id: "U_APP",
                name: "app-user",
                is_app_user: true,
                profile: { email: "person@example.com", display_name: "Person" },
              },
              {
                id: "U2",
                name: "person",
                is_bot: false,
                deleted: false,
                profile: { email: "person@example.com", display_name: "Person" },
              },
              {
                id: "U3",
                name: "another-person",
                profile: { email: "person@example.com", display_name: "Person" },
              },
            ],
          }),
        },
      };

      const res = await resolveSlackUserAllowlist({
        token: "xoxb-test",
        entries: [input],
        client: client as never,
      });

      expect(res[0]).toEqual({
        deleted: false,
        email: "person@example.com",
        id: "U2",
        input,
        isBot: false,
        name: "Person",
        note: "multiple matches; chose best",
        resolved: true,
      });
    },
  );

  it("preserves workspace-qualified user ids without listing a workspace", async () => {
    const list = vi.fn();
    const res = await resolveSlackUserAllowlist({
      token: "xoxb-test",
      entries: ["team:T11111111:user:U01234567", "team:T22222222:user:U01234567"],
      client: { users: { list } } as never,
    });

    expect(res.map((entry) => entry.id)).toEqual([
      "team:T11111111:user:U01234567",
      "team:T22222222:user:U01234567",
    ]);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    { input: "TEAM:%5411111111:USER:%5501234567", resolved: true },
    { input: "team:T11111111:channel:C01234567", resolved: false },
    { input: "team:T11111111:user:%ZZ", resolved: false },
    { input: " team:T11111111:user:U01234567", resolved: false },
  ])(
    "keeps qualified target ordering and lookup boundaries for $input",
    async ({ input, resolved }) => {
      slackClientMocks.usersList.mockResolvedValue({ members: [] });
      const first = "team:T22222222:user:U01234567";
      const last = "team:T33333333:user:U01234567";

      const result = await resolveSlackUserAllowlist({
        token: "lookup-fixture",
        entries: [first, input, last],
      });

      expect(result).toEqual([
        { input: first, resolved: true, id: first },
        resolved
          ? { input, resolved: true, id: "team:T11111111:user:U01234567" }
          : { input, resolved: false },
        { input: last, resolved: true, id: last },
      ]);
      expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledTimes(resolved ? 0 : 1);
      expect(slackClientMocks.usersList).toHaveBeenCalledTimes(resolved ? 0 : 1);
    },
  );
});
