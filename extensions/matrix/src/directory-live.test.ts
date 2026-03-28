import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestJsonMock } = vi.hoisted(() => ({
  requestJsonMock: vi.fn(),
}));

vi.mock("./matrix/client.js", () => ({
  resolveMatrixAuth: vi.fn(),
}));

vi.mock("./matrix/sdk/http-client.js", () => ({
  MatrixAuthedHttpClient: class {
    requestJson(params: unknown) {
      return requestJsonMock(params);
    }
  },
}));

let listMatrixDirectoryGroupsLive: typeof import("./directory-live.js").listMatrixDirectoryGroupsLive;
let listMatrixDirectoryPeersLive: typeof import("./directory-live.js").listMatrixDirectoryPeersLive;
let resolveMatrixAuth: typeof import("./matrix/client.js").resolveMatrixAuth;

describe("matrix directory live", () => {
  const cfg = { channels: { matrix: {} } };

  beforeEach(async () => {
    vi.resetModules();
    ({ listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } =
      await import("./directory-live.js"));
    ({ resolveMatrixAuth } = await import("./matrix/client.js"));
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

  it("passes accountId to peer directory auth resolution", async () => {
    await listMatrixDirectoryPeersLive({
      cfg,
      accountId: "assistant",
      query: "alice",
      limit: 10,
    });

    expect(resolveMatrixAuth).toHaveBeenCalledWith({ cfg, accountId: "assistant" });
  });

  it("passes accountId to group directory auth resolution", async () => {
    await listMatrixDirectoryGroupsLive({
      cfg,
      accountId: "assistant",
      query: "channel:#room:example.org",
      limit: 10,
    });

    expect(resolveMatrixAuth).toHaveBeenCalledWith({ cfg, accountId: "assistant" });
  });

  it("returns no peer results for empty query without resolving auth", async () => {
    const result = await listMatrixDirectoryPeersLive({
      cfg,
      query: "   ",
    });

    expect(result).toEqual([]);
    expect(resolveMatrixAuth).not.toHaveBeenCalled();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("returns no group results for empty query without resolving auth", async () => {
    const result = await listMatrixDirectoryGroupsLive({
      cfg,
      query: "",
    });

    expect(result).toEqual([]);
    expect(resolveMatrixAuth).not.toHaveBeenCalled();
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("preserves query casing when searching the Matrix user directory", async () => {
    await listMatrixDirectoryPeersLive({
      cfg,
      query: "Alice",
      limit: 3,
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        endpoint: "/_matrix/client/v3/user_directory/search",
        timeoutMs: 10_000,
        body: {
          search_term: "Alice",
          limit: 3,
        },
      }),
    );
  });

  it("accepts prefixed fully qualified user ids without hitting Matrix", async () => {
    const results = await listMatrixDirectoryPeersLive({
      cfg,
      query: "matrix:user:@Alice:Example.org",
    });

    expect(results).toEqual([
      {
        kind: "user",
        id: "@Alice:Example.org",
      },
    ]);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("resolves prefixed room aliases through the hardened Matrix HTTP client", async () => {
    requestJsonMock.mockResolvedValueOnce({
      room_id: "!team:example.org",
    });

    const results = await listMatrixDirectoryGroupsLive({
      cfg,
      query: "channel:#Team:Example.org",
    });

    expect(results).toEqual([
      {
        kind: "group",
        id: "!team:example.org",
        name: "#Team:Example.org",
        handle: "#Team:Example.org",
      },
    ]);
    expect(requestJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        endpoint: "/_matrix/client/v3/directory/room/%23Team%3AExample.org",
        timeoutMs: 10_000,
      }),
    );
  });

  it("accepts prefixed room ids without additional Matrix lookups", async () => {
    const results = await listMatrixDirectoryGroupsLive({
      cfg,
      query: "matrix:room:!team:example.org",
    });

    expect(results).toEqual([
      {
        kind: "group",
        id: "!team:example.org",
        name: "!team:example.org",
      },
    ]);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});
