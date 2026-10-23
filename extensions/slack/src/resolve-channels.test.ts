import { beforeEach, expect, it, vi } from "vitest";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";

const { list, createClient } = vi.hoisted(() => ({
  list: vi.fn(),
  createClient: vi.fn(),
}));

// mock-isolation: channel lookup uses the fixture client instead of real Slack network clients.
vi.mock("./client.js", () => ({ createSlackLookupClient: createClient }));

function channel(id: string, name: string) {
  return { id, name, is_archived: false };
}
function lookup(entries: string[], channels: ReturnType<typeof channel>[] = []) {
  list.mockResolvedValue({ channels });
  return resolveSlackChannelAllowlist({
    token: "xoxb-test",
    entries,
    client: { conversations: { list } } as never,
  });
}

beforeEach(() => {
  list.mockReset();
  createClient.mockReset().mockReturnValue({ conversations: { list } });
});

it("returns stable channel ids without listing a workspace", async () => {
  const res = await lookup(["C01CU3R54A1", "channel:G0AFBKXS3CP", "<#C0AG61APJ3B|general>"]);

  expect(res.map((entry) => entry.id)).toEqual(["C01CU3R54A1", "G0AFBKXS3CP", "C0AG61APJ3B"]);
  expect(list).not.toHaveBeenCalled();
});

it("does not misclassify a bare channel name starting with c/g as an id (#155820)", async () => {
  const res = await lookup(
    ["general", "c0ag61apj3b", "#c0ag61apj3b"],
    [channel("C0AG61APJ3B", "general"), channel("C01234567", "c0ag61apj3b")],
  );

  expect(list).toHaveBeenCalledOnce();
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
  const res = await lookup(
    ["general", "ca1234567", "channel:ga1234567", "#ca1234567"],
    [channel("C0AG61APJ3B", "general"), channel("C09876543", "ca1234567")],
  );

  expect(res.map((entry) => entry.id)).toEqual([
    "C0AG61APJ3B",
    "CA1234567",
    "GA1234567",
    "C09876543",
  ]);
});

it("keeps a Slack DM conversation id unresolved instead of accepting it as a channel id", async () => {
  const res = await lookup(["D0AFBKXS3CP"]);

  expect(res[0]?.resolved).toBe(false);
});

it.each(["team:T11111111:user:U01234567", "team:T11111111:channel:%ZZ"])(
  "keeps qualified target ordering and lookup boundaries for %s",
  async (input) => {
    list.mockResolvedValue({ channels: [] });
    const first = "team:T22222222:channel:C01234567";
    const last = "team:T33333333:channel:C01234567";

    const result = await resolveSlackChannelAllowlist({
      token: "lookup-fixture",
      entries: [first, input, last],
    });

    expect(result).toEqual([
      { input: first, resolved: true, id: first },
      { input, resolved: false },
      { input: last, resolved: true, id: last },
    ]);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  },
);
