import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../runtime-api.js";
import { matrixPlugin } from "./channel.js";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";

vi.mock("./directory-live.js", () => ({
  listMatrixDirectoryPeersLive: vi.fn(),
  listMatrixDirectoryGroupsLive: vi.fn(),
}));

const resolveTargets = expectDefined(matrixPlugin.resolver?.resolveTargets, "Matrix resolver");
function resolve(kind: "user" | "group", inputs: string[], accountId?: string) {
  return resolveTargets({
    cfg: {},
    inputs,
    kind,
    accountId,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
}
const user: ChannelDirectoryEntry = { kind: "user", id: "@alice:example.org", name: "Alice" };
const group: ChannelDirectoryEntry = {
  kind: "group",
  id: "!team:example.org",
  name: "Team",
  handle: "#team",
};
const partial: ChannelDirectoryEntry = { kind: "group", id: "!one:example.org", name: "General" };

describe("resolveMatrixTargets (users)", () => {
  beforeEach(() => {
    vi.mocked(listMatrixDirectoryPeersLive).mockReset();
    vi.mocked(listMatrixDirectoryGroupsLive).mockReset();
  });

  it("does not resolve ambiguous or non-exact matches", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      user,
      { ...user, id: "@alice:evil.example" },
    ]);

    const [result] = await resolve("user", ["Alice"]);

    expect(result).toMatchObject({
      resolved: false,
      note: expect.stringMatching(/use full Matrix ID/i),
    });
  });

  it.each([
    ["user", listMatrixDirectoryPeersLive, user, ["Alice", " alice "]],
    ["group", listMatrixDirectoryGroupsLive, group, ["#team", "#team"]],
  ] as const)("caches exact %s matches", async (kind, lookup, match, inputs) => {
    vi.mocked(lookup).mockResolvedValue(kind === "group" ? [partial, match] : [match]);
    expect(await resolve(kind, [...inputs], "ops")).toEqual(
      inputs.map((input) => ({
        input,
        resolved: true,
        id: match.id,
        name: match.name,
        note: undefined,
      })),
    );
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ accountId: "ops" }));
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("accepts prefixed fully qualified ids without directory lookups", async () => {
    const userResults = await resolve("user", ["matrix:user:@alice:example.org"]);
    const groupResults = await resolve("group", ["matrix:room:!team:example.org"]);

    expect(userResults).toEqual([
      { input: "matrix:user:@alice:example.org", resolved: true, id: "@alice:example.org" },
    ]);
    expect(groupResults).toEqual([
      { input: "matrix:room:!team:example.org", resolved: true, id: "!team:example.org" },
    ]);
    expect(listMatrixDirectoryPeersLive).not.toHaveBeenCalled();
    expect(listMatrixDirectoryGroupsLive).not.toHaveBeenCalled();
  });
});
