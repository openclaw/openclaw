import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";

const { list, createClient } = vi.hoisted(() => ({
  list: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("./client.js", () => ({ createSlackLookupClient: createClient }));

function lookup(
  entries: string[],
  channels: { id: string; name: string; is_archived: boolean }[] = [],
) {
  list.mockResolvedValue({ channels });
  return resolveSlackChannelAllowlist({
    token: "xoxb-test",
    entries,
    client: { conversations: { list } } as never,
  });
}

describe("resolveSlackChannelAllowlist", () => {
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
      [
        { id: "C0AG61APJ3B", name: "general", is_archived: false },
        { id: "C01234567", name: "c0ag61apj3b", is_archived: false },
      ],
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
      [
        { id: "C0AG61APJ3B", name: "general", is_archived: false },
        { id: "C09876543", name: "ca1234567", is_archived: false },
      ],
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
});
