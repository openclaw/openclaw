import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMattermostDirectoryGroups, listMattermostDirectoryPeers } from "./directory.js";

const {
  listMattermostAccountIdsMock,
  resolveMattermostAccountMock,
  createMattermostClientMock,
  fetchMattermostMeMock,
} = vi.hoisted(() => ({
  listMattermostAccountIdsMock: vi.fn(),
  resolveMattermostAccountMock: vi.fn(),
  createMattermostClientMock: vi.fn(),
  fetchMattermostMeMock: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  listMattermostAccountIds: listMattermostAccountIdsMock,
  inspectMattermostAccount: resolveMattermostAccountMock,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: createMattermostClientMock,
  fetchMattermostMe: fetchMattermostMeMock,
}));

const params = { cfg: {} as never, runtime: {} as never };
const account = (botToken: string | undefined = "token-default") => ({
  enabled: true,
  botToken,
  baseUrl: "https://chat.example.com",
  config: {},
});
function useClient(request = vi.fn().mockResolvedValueOnce([]), token = "token-default") {
  const client = { token, request };
  createMattermostClientMock.mockReturnValue(client);
  return client;
}

describe("mattermost directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMattermostAccountIdsMock.mockReturnValue(["default"]);
    resolveMattermostAccountMock.mockReturnValue(account());
    fetchMattermostMeMock.mockResolvedValue({ id: "me-1" });
  });

  it("skips an unavailable account while retaining a healthy directory client", async () => {
    useClient(undefined, "token-healthy");
    listMattermostAccountIdsMock.mockReturnValue(["broken", "healthy"]);
    resolveMattermostAccountMock.mockImplementation(({ accountId }) => ({
      ...account(),
      botToken: accountId === "broken" ? undefined : "token-healthy",
    }));

    await expect(listMattermostDirectoryGroups(params)).resolves.toEqual([]);
    expect(createMattermostClientMock).toHaveBeenCalledOnce();
  });

  it("uses only the requested account for scoped directory discovery", async () => {
    useClient(vi.fn().mockResolvedValue([]), "token-personal");
    listMattermostAccountIdsMock.mockReturnValue(["personal", "finance"]);
    resolveMattermostAccountMock.mockImplementation(({ accountId }) =>
      account(`token-${accountId}`),
    );

    await expect(
      listMattermostDirectoryGroups({ ...params, accountId: "personal" }),
    ).resolves.toEqual([]);
    expect(resolveMattermostAccountMock).toHaveBeenCalledOnce();
    expect(resolveMattermostAccountMock).toHaveBeenCalledWith({
      cfg: {},
      accountId: "personal",
    });
  });

  it("deduplicates channels across enabled accounts and skips failing accounts", async () => {
    const clientA = {
      token: "token-a",
      request: vi.fn().mockResolvedValueOnce([
        { id: "chan-1", type: "O", name: "alerts", display_name: "Alerts" },
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-3", type: "D", name: "dm", display_name: "Direct" },
      ]),
    };
    const clientB = {
      token: "token-b",
      request: vi.fn().mockRejectedValue(new Error("expired token")),
    };
    const clientC = {
      token: "token-c",
      request: vi.fn().mockResolvedValueOnce([
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-4", type: "O", name: "infra", display_name: "Infra" },
      ]),
    };

    listMattermostAccountIdsMock.mockReturnValue(["default", "alerts", "infra"]);
    resolveMattermostAccountMock.mockImplementation(({ accountId }) => {
      if (accountId === "disabled") {
        return { enabled: false, config: {} };
      }
      return account(`token-${accountId}`);
    });
    createMattermostClientMock
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB)
      .mockReturnValueOnce(clientC);

    await expect(listMattermostDirectoryGroups({ ...params, query: "  op  " })).resolves.toEqual([
      { kind: "group", id: "channel:chan-2", name: "ops", handle: "Ops" },
    ]);
  });

  it("labels public O channels as channel and private P channels as group (#95646)", async () => {
    useClient(
      vi.fn().mockResolvedValueOnce([
        { id: "pub-1", type: "O", name: "general", display_name: "General" },
        { id: "priv-1", type: "P", name: "secret", display_name: "Secret" },
        { id: "dm-1", type: "D", name: "dm", display_name: "DM" },
      ]),
    );

    await expect(listMattermostDirectoryGroups(params)).resolves.toEqual([
      { kind: "channel", id: "channel:pub-1", name: "general", handle: "General" },
      { kind: "group", id: "channel:priv-1", name: "secret", handle: "Secret" },
    ]);
  });

  it("paginates team members before resolving peer directory users in batches", async () => {
    const firstPageMembers = Array.from({ length: 200 }, (_, index) => ({
      user_id: `user-${index + 1}`,
    }));
    const client = useClient(
      vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce(firstPageMembers)
        .mockResolvedValueOnce([{ user_id: "user-201" }, { user_id: "user-202" }])
        .mockResolvedValueOnce([{ id: "user-1", username: "alice" }])
        .mockResolvedValueOnce([
          { id: "user-201", username: "zara" },
          { id: "user-202", username: "yuki" },
        ]),
    );

    await expect(listMattermostDirectoryPeers(params)).resolves.toEqual([
      { kind: "user", id: "user:user-1", name: "alice", handle: undefined },
      { kind: "user", id: "user:user-201", name: "zara", handle: undefined },
      { kind: "user", id: "user:user-202", name: "yuki", handle: undefined },
    ]);

    expect(client.request).toHaveBeenNthCalledWith(2, "/teams/team-1/members?page=0&per_page=200");
    expect(client.request).toHaveBeenNthCalledWith(3, "/teams/team-1/members?page=1&per_page=200");
    expect(client.request).toHaveBeenNthCalledWith(4, "/users/ids", {
      method: "POST",
      body: JSON.stringify(firstPageMembers.map((member) => member.user_id)),
    });
    expect(client.request).toHaveBeenNthCalledWith(5, "/users/ids", {
      method: "POST",
      body: JSON.stringify(["user-201", "user-202"]),
    });
  });

  it("uses user search when a query is present and applies limits", async () => {
    const client = useClient(
      vi
        .fn()
        .mockResolvedValueOnce([{ id: "team-1" }])
        .mockResolvedValueOnce([
          { id: "user-1", username: "alice", first_name: "Alice", last_name: "Ng" },
          { id: "user-2", username: "alex", nickname: "Lex" },
        ]),
    );

    await expect(
      listMattermostDirectoryPeers({ ...params, query: "  ali  ", limit: 1 }),
    ).resolves.toEqual([{ kind: "user", id: "user:user-1", name: "alice", handle: "Alice Ng" }]);

    expect(client.request).toHaveBeenNthCalledWith(2, "/users/search", {
      method: "POST",
      body: JSON.stringify({ term: "ali", team_id: "team-1" }),
    });
  });
});
