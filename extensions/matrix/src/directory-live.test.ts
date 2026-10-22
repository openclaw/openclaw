import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";

const { requestJsonMock } = vi.hoisted(() => ({
  requestJsonMock: vi.fn(),
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuth: vi.fn(),
}));

// mock-isolation: Directory fixtures replace the HTTP transport to prevent live Matrix requests.
vi.mock("./matrix/sdk/http-client.js", () => ({
  MatrixAuthedHttpClient: class {
    requestJson(params: unknown) {
      return requestJsonMock(params);
    }
  },
}));

describe("matrix directory live", () => {
  const cfg = { channels: { matrix: {} } };

  beforeEach(() => {
    vi.mocked(resolveMatrixAuth).mockReset();
    vi.mocked(resolveMatrixAuth).mockResolvedValue({
      accountId: "assistant",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token",
    });
    requestJsonMock.mockReset();
    requestJsonMock.mockResolvedValue({ results: [] });
  });

  it.each([
    ["peer", listMatrixDirectoryPeersLive, "   "],
    ["group", listMatrixDirectoryGroupsLive, ""],
  ] as const)(
    "returns no %s results for empty query without resolving auth",
    async (_kind, list, query) => {
      expect(await list({ cfg, query })).toStrictEqual([]);
      expect(resolveMatrixAuth).not.toHaveBeenCalled();
      expect(requestJsonMock).not.toHaveBeenCalled();
    },
  );

  it("preserves query casing when searching the Matrix user directory", async () => {
    await listMatrixDirectoryPeersLive({
      cfg,
      accountId: "assistant",
      query: "Alice",
      limit: 3,
    });

    expect(resolveMatrixAuth).toHaveBeenCalledWith({ cfg, accountId: "assistant" });
    expect(requestJsonMock).toHaveBeenCalledWith({
      method: "POST",
      endpoint: "/_matrix/client/v3/user_directory/search",
      timeoutMs: 10_000,
      body: { search_term: "Alice", limit: 3 },
    });
  });

  it.each([
    [
      "user",
      listMatrixDirectoryPeersLive,
      "matrix:user:@Alice:Example.org",
      { kind: "user", id: "@Alice:Example.org" },
    ],
    [
      "room",
      listMatrixDirectoryGroupsLive,
      "matrix:room:!team:example.org",
      { kind: "group", id: "!team:example.org", name: "!team:example.org" },
    ],
  ] as const)(
    "accepts a prefixed %s id without Matrix lookups",
    async (_kind, list, query, expected) => {
      expect(await list({ cfg, query })).toEqual([expected]);
      expect(requestJsonMock).not.toHaveBeenCalled();
    },
  );

  it("resolves prefixed room aliases through the hardened Matrix HTTP client", async () => {
    const id = "!team:example.org",
      alias = "#Team:Example.org";
    requestJsonMock.mockResolvedValueOnce({ room_id: id });

    const results = await listMatrixDirectoryGroupsLive({
      cfg,
      accountId: "assistant",
      query: `channel:${alias}`,
    });

    expect(results).toEqual([{ kind: "group", id, name: alias, handle: alias }]);
    expect(resolveMatrixAuth).toHaveBeenCalledWith({ cfg, accountId: "assistant" });
    expect(requestJsonMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/_matrix/client/v3/directory/room/%23Team%3AExample.org",
      timeoutMs: 10_000,
      body: undefined,
    });
  });

  it("rejects a non-object joined-rooms response instead of returning no groups", async () => {
    requestJsonMock.mockResolvedValue([]);

    await expect(listMatrixDirectoryGroupsLive({ cfg, query: "somegroup" })).rejects.toThrow(
      /non-object JSON response/,
    );
  });
});
