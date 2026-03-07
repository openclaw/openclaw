import { describe, expect, it, vi } from "vitest";

const {
  listTeamsByName,
  listChannelsForTeam,
  normalizeQuery,
  resolveGraphToken,
  searchGraphUsers,
} = vi.hoisted(() => ({
  listTeamsByName: vi.fn(),
  listChannelsForTeam: vi.fn(),
  normalizeQuery: vi.fn((value: string) => value.trim().toLowerCase()),
  resolveGraphToken: vi.fn(async () => "graph-token"),
  searchGraphUsers: vi.fn(),
}));

vi.mock("./graph.js", () => ({
  listTeamsByName,
  listChannelsForTeam,
  normalizeQuery,
  resolveGraphToken,
}));

vi.mock("./graph-users.js", () => ({
  searchGraphUsers,
}));

import {
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

describe("resolveMSTeamsUserAllowlist", () => {
  it("marks empty input unresolved", async () => {
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["  "] });
    expect(result).toEqual({ input: "  ", resolved: false });
  });

  it("resolves first Graph user match", async () => {
    searchGraphUsers.mockResolvedValueOnce([
      { id: "user-1", displayName: "Alice One" },
      { id: "user-2", displayName: "Alice Two" },
    ]);
    const [result] = await resolveMSTeamsUserAllowlist({ cfg: {}, entries: ["alice"] });
    expect(result).toEqual({
      input: "alice",
      resolved: true,
      id: "user-1",
      name: "Alice One",
      note: "multiple matches; chose first",
    });
  });
});

describe("resolveMSTeamsChannelAllowlist", () => {
  it("resolves team/channel by team name + channel display name", async () => {
    listTeamsByName.mockResolvedValueOnce([{ id: "team-1", displayName: "Product Team" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { id: "channel-1", displayName: "General" },
      { id: "channel-2", displayName: "Roadmap" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Product Team/Roadmap"],
    });

    expect(result).toEqual({
      input: "Product Team/Roadmap",
      resolved: true,
      teamId: "team-1",
      teamName: "Product Team",
      channelId: "channel-2",
      channelName: "Roadmap",
      note: "multiple channels; chose first",
    });
  });
});
