import { beforeEach, expect, it, vi } from "vitest";
import { resolveSlackUserAllowlist } from "./resolve-users.js";

const { createClient, list } = vi.hoisted(() => ({ createClient: vi.fn(), list: vi.fn() }));

// mock-isolation: user lookup uses the fixture client instead of real Slack network clients.
vi.mock("./client.js", () => ({
  createSlackLookupClient: createClient,
}));

function resolve(entries: string[]) {
  return resolveSlackUserAllowlist({ token: "lookup-fixture", entries });
}

function member(
  id: string,
  name: string,
  flags: { is_bot?: boolean; deleted?: boolean; is_app_user?: boolean } = {},
) {
  return { id, name, profile: { email: "person@example.com", display_name: "Person" }, ...flags };
}

beforeEach(() => {
  list.mockReset();
  createClient.mockReset().mockReturnValue({
    users: { list },
  });
});

it("uses the bounded lookup client when no client is injected", async () => {
  list.mockResolvedValue({ members: [] });

  const result = await resolve(["@missing-user"]);

  expect(result).toEqual([{ input: "@missing-user", resolved: false }]);
  expect(createClient).toHaveBeenCalledExactlyOnceWith("lookup-fixture");
  expect(list).toHaveBeenCalledOnce();
});

it.each(["person@example.com", "@Person"])(
  "resolves %s by preferring active humans and retaining directory order on ties",
  async (input) => {
    list.mockResolvedValue({
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
  const injectedList = vi.fn();
  const res = await resolveSlackUserAllowlist({
    token: "xoxb-test",
    entries: ["team:T11111111:user:U01234567", "team:T22222222:user:U01234567"],
    client: { users: { list: injectedList } } as never,
  });

  expect(res.map((entry) => entry.id)).toEqual([
    "team:T11111111:user:U01234567",
    "team:T22222222:user:U01234567",
  ]);
  expect(injectedList).not.toHaveBeenCalled();
});

it.each([
  { input: "TEAM:%5411111111:USER:%5501234567", resolved: true },
  { input: "team:T11111111:channel:C01234567", resolved: false },
  { input: "team:T11111111:user:%ZZ", resolved: false },
  { input: " team:T11111111:user:U01234567", resolved: false },
])(
  "keeps qualified target ordering and lookup boundaries for $input",
  async ({ input, resolved }) => {
    list.mockResolvedValue({ members: [] });
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
    expect(createClient).toHaveBeenCalledTimes(resolved ? 0 : 1);
    expect(list).toHaveBeenCalledTimes(resolved ? 0 : 1);
  },
);
