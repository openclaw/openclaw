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
    // After the fix, listChannelsForTeam is called once and reused for both
    // General channel resolution and channel matching.
    listTeamsByName.mockResolvedValueOnce([{ id: "team-guid-1", displayName: "Product Team" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { id: "19:general-conv-id@thread.tacv2", displayName: "General" },
      { id: "19:roadmap-conv-id@thread.tacv2", displayName: "Roadmap" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Product Team/Roadmap"],
    });

    // teamId is now the General channel's conversation ID — not the Graph GUID —
    // because that's what Bot Framework sends as channelData.team.id at runtime.
    expect(result).toEqual({
      input: "Product Team/Roadmap",
      resolved: true,
      teamId: "19:general-conv-id@thread.tacv2",
      teamName: "Product Team",
      channelId: "19:roadmap-conv-id@thread.tacv2",
      channelName: "Roadmap",
      note: "multiple channels; chose first",
    });
  });

  it("uses General channel conversation ID as team key for team-only entry", async () => {
    // When no channel is specified we still resolve the General channel so the
    // stored key matches what Bot Framework sends as channelData.team.id.
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-engineering", displayName: "Engineering" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { id: "19:eng-general@thread.tacv2", displayName: "General" },
      { id: "19:eng-standups@thread.tacv2", displayName: "Standups" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Engineering"],
    });

    expect(result).toEqual({
      input: "Engineering",
      resolved: true,
      teamId: "19:eng-general@thread.tacv2",
      teamName: "Engineering",
    });
  });

  it("falls back to Graph GUID when listChannelsForTeam throws", async () => {
    // Edge case: API call fails (rate limit, network error). We fall back to
    // the Graph GUID as the team key — the pre-fix behavior — so resolution
    // still succeeds instead of propagating the error.
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-flaky", displayName: "Flaky Team" }]);
    listChannelsForTeam.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Flaky Team"],
    });

    expect(result).toEqual({
      input: "Flaky Team",
      resolved: true,
      teamId: "guid-flaky",
      teamName: "Flaky Team",
    });
  });

  it("falls back to Graph GUID when General channel is not found", async () => {
    // Edge case: General channel was renamed or deleted. We fall back to the
    // Graph GUID so resolution still succeeds rather than silently breaking.
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-ops", displayName: "Operations" }]);
    listChannelsForTeam.mockResolvedValueOnce([
      { id: "19:ops-announce@thread.tacv2", displayName: "Announcements" },
      { id: "19:ops-random@thread.tacv2", displayName: "Random" },
    ]);

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Operations"],
    });

    expect(result).toEqual({
      input: "Operations",
      resolved: true,
      teamId: "guid-ops",
      teamName: "Operations",
    });
  });
});
