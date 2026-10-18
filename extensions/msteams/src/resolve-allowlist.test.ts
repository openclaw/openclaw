import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  resolveGraphToken,
  findGraphUsersByExactIdentity,
} = vi.hoisted(() => ({
  listTeamsByNameWithPageInfo: vi.fn(),
  listChannelsForTeamWithPageInfo: vi.fn(),
  resolveGraphToken: vi.fn(async () => "graph-token"),
  findGraphUsersByExactIdentity: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./graph.js")>()),
  listTeamsByNameWithPageInfo,
  listChannelsForTeamWithPageInfo,
  resolveGraphToken,
}));

vi.mock("./graph-users.js", () => ({
  findGraphUsersByExactIdentity,
}));

import {
  looksLikeMSTeamsTargetId,
  projectStableMSTeamsGroupAllowlist,
  projectStableMSTeamsUserAllowlist,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

function page<T>(items: T[], truncated = false) {
  return { items, truncated };
}

function users(entries: string[]) {
  return resolveMSTeamsUserAllowlist({ cfg: {}, entries });
}

function channels(
  entries: string[],
  options: Partial<Parameters<typeof resolveMSTeamsChannelAllowlist>[0]> = {},
) {
  return resolveMSTeamsChannelAllowlist({ cfg: {}, entries, ...options });
}

beforeEach(() => {
  listTeamsByNameWithPageInfo.mockReset();
  listChannelsForTeamWithPageInfo.mockReset();
  resolveGraphToken.mockReset().mockResolvedValue("graph-token");
  findGraphUsersByExactIdentity.mockReset();
});

describe("resolveMSTeamsUserAllowlist", () => {
  it("marks empty input unresolved", async () => {
    const [result] = await users(["  "]);
    expect(result).toEqual({ input: "  ", resolved: false });
  });

  it("uses the selected named account for Graph user lookup credentials", async () => {
    const cfg = { channels: { msteams: { defaultAccount: "default" } } };
    findGraphUsersByExactIdentity.mockResolvedValueOnce(
      page([{ id: "user-1", displayName: "Alice" }]),
    );

    await resolveMSTeamsUserAllowlist({ cfg, accountId: "support", entries: ["Alice"] });

    expect(resolveGraphToken).toHaveBeenCalledWith(cfg, { accountId: "support" });
  });

  it("rejects ambiguous and incomplete Graph user identities", async () => {
    findGraphUsersByExactIdentity
      .mockResolvedValueOnce(
        page([
          { id: "user-1", displayName: "Alice" },
          { id: "user-2", mail: "alice" },
        ]),
      )
      .mockResolvedValueOnce(page([{ id: "user-1", displayName: "Alice" }], true));

    await expect(users(["Alice"])).resolves.toEqual([
      { input: "Alice", resolved: false, note: "user identity is ambiguous" },
    ]);
    await expect(users(["Alice"])).resolves.toEqual([
      { input: "Alice", resolved: false, note: "user lookup incomplete" },
    ]);
  });

  it("keeps stable user IDs without acquiring a Graph token", async () => {
    await expect(users(["user:40a1a0ed-4ff2-4164-a219-55518990c197"])).resolves.toEqual([
      {
        input: "user:40a1a0ed-4ff2-4164-a219-55518990c197",
        resolved: true,
        id: "40a1a0ed-4ff2-4164-a219-55518990c197",
      },
    ]);
    expect(resolveGraphToken).not.toHaveBeenCalled();
  });
});

describe("projectStableMSTeamsUserAllowlist", () => {
  it("keeps stable IDs, wildcards, and access groups while dropping mutable identities", () => {
    expect(
      projectStableMSTeamsUserAllowlist([
        "*",
        "accessGroup:operators",
        "msteams:user:40a1a0ed-4ff2-4164-a219-55518990c197",
        "Alice Example",
      ]),
    ).toEqual(["*", "accessGroup:operators", "40a1a0ed-4ff2-4164-a219-55518990c197"]);
  });

  it("does not authorize group conversation IDs in the direct-message allowlist", () => {
    expect(
      projectStableMSTeamsUserAllowlist([
        "19:group@thread.tacv2",
        "19:legacy@thread.skype",
        "user:40a1a0ed-4ff2-4164-a219-55518990c197",
      ]),
    ).toEqual(["40a1a0ed-4ff2-4164-a219-55518990c197"]);
  });
});

describe("projectStableMSTeamsGroupAllowlist", () => {
  it("keeps normalized group conversation IDs alongside stable sender entries", () => {
    expect(
      projectStableMSTeamsGroupAllowlist([
        "19:group@thread.tacv2;messageid=1740123456789",
        "19:GROUP@THREAD.TACV2",
        "19:modern-group@thread.v2;messageid=1740123456789",
        "msteams:conversation:19:legacy@thread.skype",
        "accessGroup:operators",
        "msteams:user:40a1a0ed-4ff2-4164-a219-55518990c197",
        "Mutable Display Name",
        "a:personal-chat",
        "19:personal@unq.gbl.spaces",
      ]),
    ).toEqual([
      "19:group@thread.tacv2",
      "19:GROUP@THREAD.TACV2",
      "19:modern-group@thread.v2",
      "19:legacy@thread.skype",
      "accessGroup:operators",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
  });
});

describe("resolveMSTeamsChannelAllowlist", () => {
  it("normalizes conversation-prefixed configured channel IDs", async () => {
    const [result] = await channels([
      "19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2",
    ]);

    expect(result).toEqual({
      input: "19:team-general@thread.tacv2/conversation:19:roadmap@thread.tacv2",
      resolved: true,
      teamId: "19:team-general@thread.tacv2",
      teamName: "19:team-general@thread.tacv2",
      channelId: "19:roadmap@thread.tacv2",
      channelName: "19:roadmap@thread.tacv2",
    });
    expect(resolveGraphToken).not.toHaveBeenCalled();
  });

  it("uses General channel conversation ID as team key for team-only entry", async () => {
    // When no channel is specified we still resolve the General channel so the
    // stored key matches what Bot Framework sends as channelData.team.id.
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "guid-engineering", displayName: "Engineering" }]),
    );
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
      page([
        { id: "19:eng-general@thread.tacv2", displayName: "General" },
        { id: "19:eng-standups@thread.tacv2", displayName: "Standups" },
      ]),
    );

    const [result] = await channels(["Engineering"]);

    expect(result).toEqual({
      input: "Engineering",
      resolved: true,
      teamId: "19:eng-general@thread.tacv2",
      graphTeamId: "guid-engineering",
      teamName: "Engineering",
    });
  });

  it("fails closed when channel lookup fails", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "guid-flaky", displayName: "Flaky Team" }]),
    );
    listChannelsForTeamWithPageInfo.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    const [result] = await channels(["Flaky Team"]);

    expect(result).toEqual({
      input: "Flaky Team",
      resolved: false,
      note: "channel lookup failed",
    });
  });

  it("fails closed when the Bot Framework team key cannot be identified", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "guid-ops", displayName: "Operations" }]),
    );
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
      page([
        { id: "19:ops-announce@thread.tacv2", displayName: "Announcements" },
        { id: "19:ops-random@thread.tacv2", displayName: "Random" },
      ]),
    );

    const [result] = await channels(["Operations"]);

    expect(result).toEqual({
      input: "Operations",
      resolved: false,
      graphTeamId: "guid-ops",
      teamName: "Operations",
      note: "General channel not found",
    });
  });

  it("does not enumerate channels for a Graph-keyed team-only projection", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "guid-ops", displayName: "Operations" }]),
    );

    await expect(channels(["Operations"], { teamIdMode: "graph" })).resolves.toEqual([
      {
        input: "Operations",
        resolved: true,
        teamId: "guid-ops",
        graphTeamId: "guid-ops",
        teamName: "Operations",
      },
    ]);
    expect(listChannelsForTeamWithPageInfo).not.toHaveBeenCalled();
  });

  it("rejects partial, ambiguous, and incomplete team or channel matches", async () => {
    listTeamsByNameWithPageInfo
      .mockResolvedValueOnce(page([{ id: "team-1", displayName: "Product Team Extended" }]))
      .mockResolvedValueOnce(
        page([
          { id: "team-1", displayName: "Product Team" },
          { id: "team-2", displayName: "product team" },
        ]),
      )
      .mockResolvedValueOnce(page([{ id: "team-1", displayName: "Product Team" }], true))
      .mockResolvedValueOnce(page([{ id: "team-1", displayName: "Product Team" }]));
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
      page([
        { id: "general", displayName: "General" },
        { id: "channel-1", displayName: "Roadmap" },
        { id: "channel-2", displayName: "roadmap" },
      ]),
    );

    const results = await channels([
      "Product Team",
      "Product Team",
      "Product Team",
      "Product Team/Roadmap",
    ]);

    expect(results.map((result) => result.note)).toEqual([
      "team not found",
      "team name is ambiguous",
      "team lookup incomplete",
      "channel name is ambiguous",
    ]);
    expect(results.every((result) => !result.resolved)).toBe(true);
  });
});

describe("resolveMSTeamsTeamsConfig", () => {
  it("builds a Graph-keyed projection for action routing", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(
      page([{ id: "11111111-1111-1111-1111-111111111111", displayName: "Product Team" }]),
    );
    listChannelsForTeamWithPageInfo.mockResolvedValueOnce(
      page([
        { id: "19:general@thread.tacv2", displayName: "General" },
        { id: "19:roadmap@thread.tacv2", displayName: "Roadmap" },
      ]),
    );

    const result = await resolveMSTeamsTeamsConfig({
      cfg: {},
      teamIdMode: "graph",
      teams: {
        "Product Team": {
          channels: {
            Roadmap: { requireMention: true },
          },
        },
      },
    });

    expect(result.mapping).toEqual([
      "Product Team/Roadmap→11111111-1111-1111-1111-111111111111/19:roadmap@thread.tacv2",
    ]);
    expect(result.teams["11111111-1111-1111-1111-111111111111"]).toMatchObject({
      channels: {
        "19:roadmap@thread.tacv2": { requireMention: true },
      },
    });
  });

  it("drops unresolved mutable keys while retaining wildcard and stable policy", async () => {
    listTeamsByNameWithPageInfo.mockResolvedValueOnce(page([]));

    const result = await resolveMSTeamsTeamsConfig({
      cfg: {},
      teamIdMode: "bot-framework",
      teams: {
        "*": {
          channels: {
            "*": { requireMention: true },
            Mutable: { requireMention: false },
            "19:stable@thread.tacv2": { requireMention: false },
          },
        },
        Missing: {
          channels: {
            Roadmap: { requireMention: false },
          },
        },
      },
    });

    expect(result.teams).toEqual({
      "*": {
        channels: {
          "*": { requireMention: true },
          "19:stable@thread.tacv2": { requireMention: false },
        },
      },
    });
    expect(result.unresolved).toEqual(["*/Mutable", "Missing/Roadmap"]);
  });
});

describe("looksLikeMSTeamsTargetId", () => {
  it.each(["8:orgid:user-object-id"])("accepts explicit target %s", (raw) => {
    expect(looksLikeMSTeamsTargetId(raw)).toBe(true);
  });

  it.each(["user:John Smith", "Product Team/Roadmap"])("rejects non-id input %s", (raw) => {
    expect(looksLikeMSTeamsTargetId(raw)).toBe(false);
  });
});
