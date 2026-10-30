import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  searchGraphUsersMock,
  listTeamsByNameMock,
  listChannelsForTeamMock,
  resolveGraphTokenMock,
} = vi.hoisted(() => ({
  searchGraphUsersMock: vi.fn(),
  listTeamsByNameMock: vi.fn(),
  listChannelsForTeamMock: vi.fn(),
  resolveGraphTokenMock: vi.fn(),
}));

// mock-isolation: Directory results use fixed users without calling Microsoft Graph.
vi.mock("./graph-users.js", () => ({ searchGraphUsers: searchGraphUsersMock }));

// mock-isolation: Directory queries use fixed teams and tokens without network authentication.
vi.mock("./graph.js", () => ({
  listTeamsByNameWithPageInfo: listTeamsByNameMock,
  listChannelsForTeamWithPageInfo: listChannelsForTeamMock,
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
    resolveGraphTokenMock.mockResolvedValue("graph-token");
    searchGraphUsersMock.mockResolvedValue([]);
    listTeamsByNameMock.mockResolvedValue({ items: [], truncated: false });
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

  it.each([
    ["peers", listMSTeamsDirectoryPeersLive],
    ["groups", listMSTeamsDirectoryGroupsLive],
  ] as const)("returns no %s for a blank query without acquiring a token", async (_kind, list) => {
    await expect(list({ cfg, query: "   " })).resolves.toEqual([]);
    expect(resolveGraphTokenMock).not.toHaveBeenCalled();
  });

  it("returns team entries without channel queries and honors limits", async () => {
    listTeamsByNameMock.mockResolvedValue({ items: teams, truncated: false });

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "platform",
        limit: 1,
      }),
    ).resolves.toEqual([entry("group", "team:team-1", "Platform", "#Platform", teams[0])]);
  });

  it("searches channels within matching teams when a team/channel query is used", async () => {
    listTeamsByNameMock.mockResolvedValue({ items: teams, truncated: false });
    listChannelsForTeamMock
      .mockResolvedValueOnce({ items: channels.slice(0, 2), truncated: false })
      .mockResolvedValueOnce({ items: channels.slice(2), truncated: false });

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

  it("matches channels by canonically equivalent names across NFC and NFD forms", async () => {
    const mixedChannels = [
      { id: "chan-nfc", displayName: "Café" },
      { id: "chan-nfd", displayName: "Café" },
    ];
    listTeamsByNameMock.mockResolvedValue({ items: [teams[0]], truncated: false });
    listChannelsForTeamMock.mockResolvedValue({ items: mixedChannels, truncated: false });

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "platform/café",
      }),
    ).resolves.toEqual([
      entry("group", "conversation:chan-nfc", "Platform/Café", "#Café", mixedChannels[0]),
      entry("group", "conversation:chan-nfd", "Platform/Café", "#Café", mixedChannels[1]),
    ]);
  });

  it("matches an NFD channel query against NFC channel names", async () => {
    const nfcChannels = [{ id: "chan-nfc", displayName: "Café" }];
    listTeamsByNameMock.mockResolvedValue({ items: [teams[0]], truncated: false });
    listChannelsForTeamMock.mockResolvedValue({ items: nfcChannels, truncated: false });

    await expect(
      listMSTeamsDirectoryGroupsLive({
        cfg: {},
        query: "platform/café",
      }),
    ).resolves.toEqual([
      entry("group", "conversation:chan-nfc", "Platform/Café", "#Café", nfcChannels[0]),
    ]);
  });
});
