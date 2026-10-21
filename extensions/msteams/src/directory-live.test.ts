import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  searchGraphUsersMock,
  listTeamsByNameMock,
  listChannelsForTeamMock,
  normalizeQueryMock,
  resolveGraphTokenMock,
} = vi.hoisted(() => ({
  searchGraphUsersMock: vi.fn(),
  listTeamsByNameMock: vi.fn(),
  listChannelsForTeamMock: vi.fn(),
  normalizeQueryMock: vi.fn((value?: string | null) => value?.trim() ?? ""),
  resolveGraphTokenMock: vi.fn(),
}));

// mock-isolation: Directory results use fixed users without calling Microsoft Graph.
vi.mock("./graph-users.js", () => ({ searchGraphUsers: searchGraphUsersMock }));

// mock-isolation: Directory queries use fixed teams and tokens without network authentication.
vi.mock("./graph.js", () => ({
  listTeamsByName: listTeamsByNameMock,
  listChannelsForTeam: listChannelsForTeamMock,
  normalizeQuery: normalizeQueryMock,
  resolveGraphToken: resolveGraphTokenMock,
}));

import { listMSTeamsDirectoryGroupsLive, listMSTeamsDirectoryPeersLive } from "./directory-live.js";

const teams = [
  { id: "team-1", displayName: "Platform" },
  { id: "team-2", displayName: "Infra" },
];
const channels = [
  { id: "chan-1", displayName: "Deployments" },
  { id: "chan-2", displayName: "General" },
  { id: "chan-3", displayName: "Deployments-West" },
];
const users = [
  { id: "user-1", displayName: "Alice", userPrincipalName: "alice@example.com" },
  { id: "user-2", displayName: "Bob", mail: "bob@example.com" },
  { displayName: "Missing Id" },
];
const cfg = {
  channels: {
    msteams: {
      appId: "default-app-id",
      accounts: {
        secondary: { appId: "secondary-app-id" },
      },
    },
  },
};

const entry = (kind: "user" | "group", id: string, name: string, handle: string, raw: unknown) => ({
  kind,
  id,
  name,
  handle,
  raw,
});

describe("msteams directory live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    normalizeQueryMock.mockImplementation((value?: string | null) => value?.trim() ?? "");
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    searchGraphUsersMock.mockResolvedValue([]);
    listTeamsByNameMock.mockResolvedValue([]);
  });

  it("returns normalized peer entries and skips users without ids", async () => {
    searchGraphUsersMock.mockResolvedValue(users);

    await expect(
      listMSTeamsDirectoryPeersLive({
        cfg: {},
        query: "  ali  ",
      }),
    ).resolves.toEqual([
      entry("user", "user:user-1", "Alice", "@alice@example.com", users[0]),
      entry("user", "user:user-2", "Bob", "@bob@example.com", users[1]),
    ]);

    expect(searchGraphUsersMock).toHaveBeenCalledWith({
      token: "graph-token",
      query: "ali",
      top: 20,
    });
  });

  it.each([
    ["peers", listMSTeamsDirectoryPeersLive, "alice"],
    ["groups", listMSTeamsDirectoryGroupsLive, "platform"],
  ] as const)("resolves %s with the named account", async (_kind, list, query) => {
    await list({ cfg, accountId: "secondary", query });
    expect(resolveGraphTokenMock).toHaveBeenCalledWith(cfg, { accountId: "secondary" });
  });

  it("returns team entries without channel queries and honors limits", async () => {
    listTeamsByNameMock.mockResolvedValue(teams);

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "platform",
        limit: 1,
      }),
    ).resolves.toEqual([entry("group", "team:team-1", "Platform", "#Platform", teams[0])]);
  });

  it("searches channels within matching teams when a team/channel query is used", async () => {
    listTeamsByNameMock.mockResolvedValue(teams);
    listChannelsForTeamMock
      .mockResolvedValueOnce(channels.slice(0, 2))
      .mockResolvedValueOnce(channels.slice(2));

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "plat / deploy",
      }),
    ).resolves.toEqual([
      entry("group", "conversation:chan-1", "Platform/Deployments", "#Deployments", channels[0]),
      entry(
        "group",
        "conversation:chan-3",
        "Infra/Deployments-West",
        "#Deployments-West",
        channels[2],
      ),
    ]);

    expect(listTeamsByNameMock).toHaveBeenCalledWith("graph-token", "plat");
  });
});
