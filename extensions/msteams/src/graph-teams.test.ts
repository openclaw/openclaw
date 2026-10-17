// Msteams tests cover graph teams plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createGraphPageGuard } from "./graph-pagination.test-support.js";
import { getChannelInfoMSTeams, listChannelsMSTeams } from "./graph-teams.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return { ...actual, fetchWithSsrFGuard: mockState.fetchWithSsrFGuard };
});

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
  };
});

const TOKEN = "test-graph-token";

beforeEach(() => {
  mockState.resolveGraphToken.mockReset().mockResolvedValue(TOKEN);
  mockState.fetchGraphJson.mockReset();
  mockState.fetchWithSsrFGuard
    .mockReset()
    .mockImplementation(createGraphPageGuard(mockState.fetchGraphJson));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("listChannelsMSTeams", () => {
  it("returns channels with all fields mapped", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      value: [
        {
          id: "ch-1",
          displayName: "General",
          description: "The default channel",
          membershipType: "standard",
        },
        {
          id: "ch-2",
          displayName: "Engineering",
          description: "Engineering discussions",
          membershipType: "private",
        },
      ],
    });

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
    });

    expect(result.channels).toEqual([
      {
        id: "ch-1",
        displayName: "General",
        description: "The default channel",
        membershipType: "standard",
      },
      {
        id: "ch-2",
        displayName: "Engineering",
        description: "Engineering discussions",
        membershipType: "private",
      },
    ]);
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/teams/${encodeURIComponent("team-abc")}/channels?$select=id,displayName,description,membershipType`,
    });
  });

  it("returns empty array when value is undefined", async () => {
    mockState.fetchGraphJson.mockResolvedValue({});

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-no-value",
    });

    expect(result.channels).toStrictEqual([]);
  });
});

describe("getChannelInfoMSTeams", () => {
  it.each([
    {},
    { value: null },
    { value: "not-a-list" },
    { value: [], "@odata.nextLink": false },
    { value: [], "@odata.nextLink": "" },
    { value: [{}] },
    { value: [{ userId: " " }] },
    { value: [{ userId: "aad-user", "@odata.type": "#microsoft.graph.futureMember" }] },
  ])("does not certify a malformed roster response: %j", async (page) => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ id: "ch-private", membershipType: "private" })
      .mockResolvedValueOnce(page);
    await expect(
      getChannelInfoMSTeams({
        cfg: {},
        teamId: "team-abc",
        channelId: "ch-private",
        includeMembers: true,
      }),
    ).rejects.toThrow();
  });

  it("rejects metadata for a different channel before fetching its roster", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ id: "other-channel", membershipType: "private" })
      .mockResolvedValueOnce({ value: [] });
    await expect(
      getChannelInfoMSTeams({
        cfg: {},
        teamId: "team-abc",
        channelId: "ch-private",
        includeMembers: true,
      }),
    ).rejects.toThrow("channel identity");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("returns channel with all fields", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "ch-1",
      displayName: "General",
      description: "The default channel",
      membershipType: "standard",
      webUrl: "https://teams.microsoft.com/l/channel/ch-1/General",
      createdDateTime: "2026-01-15T09:00:00Z",
    });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
      channelId: "ch-1",
    });

    expect(result.channel).toEqual({
      id: "ch-1",
      displayName: "General",
      description: "The default channel",
      membershipType: "standard",
      webUrl: "https://teams.microsoft.com/l/channel/ch-1/General",
      createdDateTime: "2026-01-15T09:00:00Z",
    });
    expect(mockState.fetchGraphJson).toHaveBeenCalledWith({
      token: TOKEN,
      path: `/teams/${encodeURIComponent("team-abc")}/channels/${encodeURIComponent("ch-1")}?$select=id,displayName,description,membershipType,webUrl,createdDateTime`,
    });
  });

  it("does not fetch members when includeMembers is omitted (existing behavior unchanged)", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "ch-1",
      displayName: "General",
      membershipType: "standard",
    });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
      channelId: "ch-1",
    });

    expect(result).toEqual({
      channel: { id: "ch-1", displayName: "General", membershipType: "standard" },
    });
    expect(result).not.toHaveProperty("members");
    // Only the single channel-metadata call; no roster call was made.
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
  });

  it("returns every private-channel page with the start of observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00.000Z"));
    mockState.fetchGraphJson
      .mockResolvedValueOnce({
        id: "ch-private",
        displayName: "Private Operations",
        membershipType: "private",
      })
      .mockResolvedValueOnce({
        value: [{ userId: "aad-alice", displayName: "Alice" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/team-abc/channels/ch-private/members?$skiptoken=page2",
      })
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-01-01T10:01:00.000Z"));
        return {
          value: [
            { userId: "aad-bob", displayName: "Bob" },
            { userId: "aad-unexpected-guest", displayName: "Unexpected Guest" },
          ],
        };
      });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
      channelId: "ch-private",
      includeMembers: true,
    });

    expect(result.channel).toMatchObject({ id: "ch-private", membershipType: "private" });
    expect(result.members).toEqual([
      { userId: "aad-alice", displayName: "Alice" },
      { userId: "aad-bob", displayName: "Bob" },
      { userId: "aad-unexpected-guest", displayName: "Unexpected Guest" },
    ]);
    expect(result.membersComplete).toBe(true);
    expect(result.membersFetchedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(result.membersScope).toEqual({
      teamId: "team-abc",
      channelId: "ch-private",
      membershipType: "private",
    });
    // The roster call must target this exact channel, never the parent team's /members.
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(3);
    expect(mockState.fetchGraphJson).toHaveBeenNthCalledWith(2, {
      token: TOKEN,
      path: `/teams/${encodeURIComponent("team-abc")}/channels/${encodeURIComponent("ch-private")}/members`,
    });
  });

  it.each(["standard", "shared", "future", undefined])(
    "rejects unsupported roster scope %s",
    async (membershipType) => {
      mockState.fetchGraphJson.mockResolvedValueOnce({ id: "ch-1", membershipType });
      await expect(
        getChannelInfoMSTeams({
          cfg: {},
          teamId: "team-abc",
          channelId: "ch-1",
          includeMembers: true,
        }),
      ).rejects.toThrow("not supported");
      expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects a roster when pagination does not finish within its bound", async () => {
    mockState.fetchGraphJson
      .mockResolvedValueOnce({ id: "ch-private", membershipType: "private" })
      .mockResolvedValue({
        value: [{ userId: "aad-x" }],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/teams/team-abc/channels/ch-private/members?$skiptoken=more",
      });
    await expect(
      getChannelInfoMSTeams({
        cfg: {},
        teamId: "team-abc",
        channelId: "ch-private",
        includeMembers: true,
      }),
    ).rejects.toThrow("pagination limit exceeded");
    expect(mockState.fetchGraphJson).toHaveBeenCalledTimes(101);
  });

  it("propagates a denied roster read without returning metadata as success", async () => {
    mockState.fetchGraphJson.mockResolvedValueOnce({ id: "ch-private", membershipType: "private" });
    mockState.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("Access denied", { status: 403 }),
      release: async () => undefined,
    });
    await expect(
      getChannelInfoMSTeams({
        cfg: {},
        teamId: "team-abc",
        channelId: "ch-private",
        includeMembers: true,
      }),
    ).rejects.toThrow("403");
  });
});
