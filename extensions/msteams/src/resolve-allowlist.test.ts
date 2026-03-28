import { beforeEach, describe, expect, it, vi } from "vitest";
import * as graphUsersModule from "./graph-users.js";
import * as graphModule from "./graph.js";
import {
  parseMSTeamsConversationId,
  parseMSTeamsExplicitTarget,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

let getPrimaryChannelForTeam: ReturnType<typeof vi.fn>;
let listTeamsByName: ReturnType<typeof vi.fn>;
let listChannelsForTeam: ReturnType<typeof vi.fn>;
let normalizeQuery: ReturnType<typeof vi.fn>;
let resolveGraphToken: ReturnType<typeof vi.fn>;
let searchGraphUsers: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getPrimaryChannelForTeam = vi.spyOn(graphModule, "getPrimaryChannelForTeam").mockReset();
  listTeamsByName = vi.spyOn(graphModule, "listTeamsByName").mockReset();
  listChannelsForTeam = vi.spyOn(graphModule, "listChannelsForTeam").mockReset();
  normalizeQuery = vi
    .spyOn(graphModule, "normalizeQuery")
    .mockImplementation((value?: string | null) => value?.trim().toLowerCase() ?? "");
  resolveGraphToken = vi.spyOn(graphModule, "resolveGraphToken").mockResolvedValue("graph-token");
  searchGraphUsers = vi.spyOn(graphUsersModule, "searchGraphUsers").mockReset();
});

describe("parseMSTeamsExplicitTarget", () => {
  it("normalizes provider-prefixed Teams DM targets", () => {
    expect(parseMSTeamsExplicitTarget("msteams:user:29:alice")).toEqual({
      to: "user:29:alice",
      chatType: "direct",
    });
  });

  it("normalizes provider-prefixed Teams conversation targets", () => {
    expect(parseMSTeamsExplicitTarget("teams:conversation:19:room@thread.tacv2")).toEqual({
      to: "conversation:19:room@thread.tacv2",
      chatType: "channel",
    });
  });
});

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
    listTeamsByName.mockResolvedValueOnce([{ id: "team-guid-1", displayName: "Product Team" }]);
    getPrimaryChannelForTeam.mockResolvedValueOnce({
      id: "19:general-conv-id@thread.tacv2",
      displayName: "Allgemein",
    });
    listChannelsForTeam.mockResolvedValueOnce([
      { id: "19:general-conv-id@thread.tacv2", displayName: "Allgemein" },
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
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-engineering", displayName: "Engineering" }]);
    getPrimaryChannelForTeam.mockResolvedValueOnce({
      id: "19:eng-general@thread.tacv2",
      displayName: "Primair",
    });

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

  it("marks team-only entry unresolved when primary channel lookup fails", async () => {
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-flaky", displayName: "Flaky Team" }]);
    getPrimaryChannelForTeam.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Flaky Team"],
    });

    expect(result).toEqual({
      input: "Flaky Team",
      resolved: false,
      note: "primary channel unavailable",
    });
  });

  it("marks team-only entry unresolved when the primary channel id is missing", async () => {
    listTeamsByName.mockResolvedValueOnce([{ id: "guid-ops", displayName: "Operations" }]);
    getPrimaryChannelForTeam.mockResolvedValueOnce({ displayName: "General" });

    const [result] = await resolveMSTeamsChannelAllowlist({
      cfg: {},
      entries: ["Operations"],
    });

    expect(result).toEqual({
      input: "Operations",
      resolved: false,
      note: "primary channel unavailable",
    });
  });

  it("accepts provider-prefixed channel aliases as conversation ids", () => {
    expect(parseMSTeamsConversationId("teams:channel:19:room@thread.tacv2")).toBe(
      "19:room@thread.tacv2",
    );
    expect(parseMSTeamsConversationId("msteams:group:19:room@thread.tacv2")).toBe(
      "19:room@thread.tacv2",
    );
  });
});
