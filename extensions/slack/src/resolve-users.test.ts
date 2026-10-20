import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

const slackClientMocks = vi.hoisted(() => ({
  createSlackLookupClient: vi.fn(),
  usersList: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createSlackLookupClient: slackClientMocks.createSlackLookupClient,
}));

function resolve(entries: string[]) {
  return resolveSlackUserAllowlist({ token: "lookup-fixture", entries });
}

function member(id: string, name: string, flags = {}) {
  return { id, name, profile: { email: "person@example.com", display_name: "Person" }, ...flags };
}

describe("resolveSlackUserAllowlist", () => {
  beforeEach(() => {
    slackClientMocks.usersList.mockReset();
    slackClientMocks.createSlackLookupClient.mockReset().mockReturnValue({
      users: { list: slackClientMocks.usersList },
    });
  });

  it("uses the bounded lookup client when no client is injected", async () => {
    slackClientMocks.usersList.mockResolvedValue({ members: [] });

    const result = await resolve(["@missing-user"]);

    expect(result).toEqual([{ input: "@missing-user", resolved: false }]);
    expect(slackClientMocks.createSlackLookupClient).toHaveBeenCalledExactlyOnceWith(
      "lookup-fixture",
    );
    expect(slackClientMocks.usersList).toHaveBeenCalledOnce();
  });

  it.each(["person@example.com", "@Person"])(
    "resolves %s by preferring active humans and retaining directory order on ties",
    async (input) => {
      slackClientMocks.usersList.mockResolvedValue({
        members: [
          member("U1", "bot-user", { is_bot: true, deleted: false }),
          member("U_DELETED", "deleted-person", { deleted: true }),
          member("U_APP", "app-user", { is_app_user: true }),
          member("U2", "person", { is_bot: false, deleted: false }),
          member("U3", "another-person"),
        ],
      });
      const res = await resolve([input]);
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

      const result = await resolve([first, input, last]);

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
