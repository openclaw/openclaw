import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../runtime-api.js";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

vi.mock("./directory-live.js", () => ({
  listMatrixDirectoryPeersLive: vi.fn(),
  listMatrixDirectoryGroupsLive: vi.fn(),
}));

function resolve(kind: "user" | "group", inputs: string[], accountId?: string) {
  return resolveMatrixTargets({ cfg: {}, inputs, kind, accountId });
}

describe("resolveMatrixTargets (users)", () => {
  beforeEach(() => {
    vi.mocked(listMatrixDirectoryPeersLive).mockReset();
    vi.mocked(listMatrixDirectoryGroupsLive).mockReset();
  });

  it("does not resolve ambiguous or non-exact matches", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "user", id: "@alice:example.org", name: "Alice" },
      { kind: "user", id: "@alice:evil.example", name: "Alice" },
    ];
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue(matches);

    const [result] = await resolve("user", ["Alice"]);

    expect(result?.resolved).toBe(false);
    expect(result?.note).toMatch(/use full Matrix ID/i);
  });

  it("prefers exact group matches over first partial result", async () => {
    const matches: ChannelDirectoryEntry[] = [
      { kind: "group", id: "!one:example.org", name: "General", handle: "#general" },
      { kind: "group", id: "!two:example.org", name: "Team", handle: "#team" },
    ];
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue(matches);

    const [result] = await resolve("group", ["#team"]);

    expect(result?.resolved).toBe(true);
    expect(result?.id).toBe("!two:example.org");
    expect(result?.note).toBeUndefined();
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: undefined,
      query: "#team",
      limit: 5,
    });
  });

  it("reuses directory lookups for normalized duplicate inputs", async () => {
    vi.mocked(listMatrixDirectoryPeersLive).mockResolvedValue([
      { kind: "user", id: "@alice:example.org", name: "Alice" },
    ]);
    vi.mocked(listMatrixDirectoryGroupsLive).mockResolvedValue([
      { kind: "group", id: "!team:example.org", name: "Team", handle: "#team" },
    ]);

    const userResults = await resolve("user", ["Alice", " alice "], "ops");
    const groupResults = await resolve("group", ["#team", "#team"], "ops");

    expect(userResults).toEqual([
      { input: "Alice", resolved: true, id: "@alice:example.org", name: "Alice", note: undefined },
      {
        input: " alice ",
        resolved: true,
        id: "@alice:example.org",
        name: "Alice",
        note: undefined,
      },
    ]);
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: "ops",
      query: "Alice",
      limit: 5,
    });
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledWith({
      cfg: {},
      accountId: "ops",
      query: "#team",
      limit: 5,
    });
    expect(groupResults.every((entry) => entry.resolved)).toBe(true);
    expect(listMatrixDirectoryPeersLive).toHaveBeenCalledTimes(1);
    expect(listMatrixDirectoryGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("accepts prefixed fully qualified ids without directory lookups", async () => {
    const userResults = await resolve("user", ["matrix:user:@alice:example.org"]);
    const groupResults = await resolve("group", ["matrix:room:!team:example.org"]);

    expect(userResults).toEqual([
      {
        input: "matrix:user:@alice:example.org",
        resolved: true,
        id: "@alice:example.org",
      },
    ]);
    expect(groupResults).toEqual([
      {
        input: "matrix:room:!team:example.org",
        resolved: true,
        id: "!team:example.org",
      },
    ]);
    expect(listMatrixDirectoryPeersLive).not.toHaveBeenCalled();
    expect(listMatrixDirectoryGroupsLive).not.toHaveBeenCalled();
  });
});
