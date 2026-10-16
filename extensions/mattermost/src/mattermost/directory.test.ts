import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMattermostDirectoryGroups, listMattermostDirectoryPeers } from "./directory.js";

const mocks = vi.hoisted(() => ({
  accountIds: vi.fn(),
  account: vi.fn(),
  client: vi.fn(),
  me: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  listMattermostAccountIds: mocks.accountIds,
  inspectMattermostAccount: mocks.account,
}));

vi.mock("./client.js", () => ({
  createMattermostClient: mocks.client,
  fetchMattermostMe: mocks.me,
}));

const params = { cfg: {} as never, runtime: {} as never };
const account = (botToken = "token-default") => ({
  enabled: true,
  botToken,
  baseUrl: "https://chat.example.com",
  config: {},
});
function useClient(request = replies([]), token = "token-default") {
  const client = makeClient(request, token);
  mocks.client.mockReturnValue(client);
  return client;
}
function makeClient(request: ReturnType<typeof vi.fn>, token: string) {
  return { token, request };
}
function replies(...pages: unknown[]) {
  const request = vi.fn();
  for (const page of pages) {
    request.mockResolvedValueOnce(page);
  }
  return request;
}

describe("mattermost directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountIds.mockReturnValue(["default"]);
    mocks.account.mockReturnValue(account());
    mocks.me.mockResolvedValue({ id: "me-1" });
  });

  it("skips an unavailable account while retaining a healthy directory client", async () => {
    useClient(undefined, "token-healthy");
    mocks.accountIds.mockReturnValue(["broken", "healthy"]);
    mocks.account.mockImplementation(({ accountId }) => ({
      ...account(),
      botToken: accountId === "broken" ? undefined : "token-healthy",
    }));

    await expect(listMattermostDirectoryGroups(params)).resolves.toEqual([]);
    expect(mocks.client).toHaveBeenCalledOnce();
  });

  it("uses only the requested account for scoped directory discovery", async () => {
    useClient(vi.fn().mockResolvedValue([]), "token-personal");
    mocks.accountIds.mockReturnValue(["personal", "finance"]);
    mocks.account.mockImplementation(({ accountId }) => account(`token-${accountId}`));

    await expect(
      listMattermostDirectoryGroups({ ...params, accountId: "personal" }),
    ).resolves.toEqual([]);
    expect(mocks.account).toHaveBeenCalledOnce();
    expect(mocks.account).toHaveBeenCalledWith({
      cfg: {},
      accountId: "personal",
    });
  });

  it("deduplicates channels across enabled accounts and skips failing accounts", async () => {
    const clientA = makeClient(
      replies([
        { id: "chan-1", type: "O", name: "alerts", display_name: "Alerts" },
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-3", type: "D", name: "dm", display_name: "Direct" },
      ]),
      "token-a",
    );
    const clientB = makeClient(vi.fn().mockRejectedValue(new Error("expired token")), "token-b");
    const clientC = makeClient(
      replies([
        { id: "chan-2", type: "P", name: "ops", display_name: "Ops" },
        { id: "chan-4", type: "O", name: "infra", display_name: "Infra" },
      ]),
      "token-c",
    );

    mocks.accountIds.mockReturnValue(["default", "alerts", "infra"]);
    mocks.account.mockImplementation(({ accountId }) => account(`token-${accountId}`));
    mocks.client
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB)
      .mockReturnValueOnce(clientC);

    await expect(listMattermostDirectoryGroups({ ...params, query: "  op  " })).resolves.toEqual([
      { kind: "group", id: "channel:chan-2", name: "ops", handle: "Ops" },
    ]);
  });

  it("labels public O channels as channel and private P channels as group (#95646)", async () => {
    useClient(
      replies([
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
      replies(
        [{ id: "team-1" }],
        firstPageMembers,
        [{ user_id: "user-201" }, { user_id: "user-202" }],
        [{ id: "user-1", username: "alice" }],
        [
          { id: "user-201", username: "zara" },
          { id: "user-202", username: "yuki" },
        ],
      ),
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
      replies(
        [{ id: "team-1" }],
        [
          { id: "user-1", username: "alice", first_name: "Alice", last_name: "Ng" },
          { id: "user-2", username: "alex", nickname: "Lex" },
        ],
      ),
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
