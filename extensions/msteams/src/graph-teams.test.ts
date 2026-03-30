import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { getChannelInfoMSTeams, listChannelsMSTeams } from "./graph-teams.js";

const mockState = vi.hoisted(() => ({
  resolveGraphToken: vi.fn(),
  fetchGraphJson: vi.fn(),
}));

vi.mock("./graph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./graph.js")>();
  return {
    ...actual,
    resolveGraphToken: mockState.resolveGraphToken,
    fetchGraphJson: mockState.fetchGraphJson,
  };
});

const TOKEN = "test-graph-token";

describe("listChannelsMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
  });

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

  it("returns empty array when team has no channels", async () => {
    mockState.fetchGraphJson.mockResolvedValue({ value: [] });

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-empty",
    });

    expect(result.channels).toEqual([]);
  });

  it("returns empty array when value is undefined", async () => {
    mockState.fetchGraphJson.mockResolvedValue({});

    const result = await listChannelsMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-no-value",
    });

    expect(result.channels).toEqual([]);
  });
});

describe("getChannelInfoMSTeams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.resolveGraphToken.mockResolvedValue(TOKEN);
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

  it("handles missing optional fields gracefully", async () => {
    mockState.fetchGraphJson.mockResolvedValue({
      id: "ch-2",
      displayName: "Private Channel",
    });

    const result = await getChannelInfoMSTeams({
      cfg: {} as OpenClawConfig,
      teamId: "team-abc",
      channelId: "ch-2",
    });

    expect(result.channel).toEqual({
      id: "ch-2",
      displayName: "Private Channel",
      description: undefined,
      membershipType: undefined,
      webUrl: undefined,
      createdDateTime: undefined,
    });
  });
});
