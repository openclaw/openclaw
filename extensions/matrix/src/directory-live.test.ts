import { beforeEach, describe, expect, it, vi } from "vitest";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { resolveMatrixAuth } from "./matrix/client.js";

const { requestJsonMock } = vi.hoisted(() => ({ requestJsonMock: vi.fn() }));

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
  const scoped = { cfg, accountId: "assistant" };
  function expectRequest(method: string, endpoint: string, body?: unknown) {
    expect(resolveMatrixAuth).toHaveBeenCalledWith(scoped);
    expect(requestJsonMock).toHaveBeenCalledWith({ method, endpoint, timeoutMs: 10_000, body });
  }

  beforeEach(() => {
    vi.mocked(resolveMatrixAuth).mockReset().mockResolvedValue({
      accountId: "assistant",
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "test-token",
    });
    requestJsonMock.mockReset().mockResolvedValue({ results: [] });
  });

  it("preserves query casing when searching the Matrix user directory", async () => {
    await listMatrixDirectoryPeersLive({ ...scoped, query: "Alice", limit: 3 });
    expectRequest("POST", "/_matrix/client/v3/user_directory/search", {
      search_term: "Alice",
      limit: 3,
    });
  });

  it.each([
    [listMatrixDirectoryPeersLive, "   ", []],
    [listMatrixDirectoryGroupsLive, "", []],
    [
      listMatrixDirectoryPeersLive,
      "matrix:user:@Alice:Example.org",
      [{ kind: "user", id: "@Alice:Example.org" }],
    ],
    [
      listMatrixDirectoryGroupsLive,
      "matrix:room:!team:example.org",
      [{ kind: "group", id: "!team:example.org", name: "!team:example.org" }],
    ],
  ] as const)("resolves %s %s locally", async (list, query, expected) => {
    expect(await list({ cfg, query })).toEqual(expected);
    expect(resolveMatrixAuth).not.toHaveBeenCalled();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("resolves prefixed room aliases through the hardened Matrix HTTP client", async () => {
    const id = "!team:example.org",
      alias = "#Team:Example.org";
    requestJsonMock.mockResolvedValueOnce({ room_id: id });

    const results = await listMatrixDirectoryGroupsLive({ ...scoped, query: `channel:${alias}` });
    expect(results).toEqual([{ kind: "group", id, name: alias, handle: alias }]);
    expectRequest("GET", "/_matrix/client/v3/directory/room/%23Team%3AExample.org");
  });

  it("rejects a non-object joined-rooms response instead of returning no groups", async () => {
    requestJsonMock.mockResolvedValue([]);

    await expect(listMatrixDirectoryGroupsLive({ cfg, query: "somegroup" })).rejects.toThrow(
      /non-object JSON response/,
    );
  });
});
