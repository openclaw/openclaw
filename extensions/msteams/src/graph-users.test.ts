import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchGraphUsers } from "./graph-users.js";
import { fetchGraphJson } from "./graph.js";

vi.mock("./graph.js", () => ({
  escapeOData: vi.fn((value: string) => value.replace(/'/g, "''")),
  fetchGraphJson: vi.fn(),
}));

describe("searchGraphUsers", () => {
  beforeEach(() => {
    vi.mocked(fetchGraphJson).mockReset();
  });

  it("returns empty array for blank queries", async () => {
    await expect(searchGraphUsers({ token: "token-1", query: "   " })).resolves.toEqual([]);
    expect(fetchGraphJson).not.toHaveBeenCalled();
  });

  it("uses exact mail/upn filter lookup for email-like queries", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      value: [{ id: "user-1", displayName: "User One" }],
    } as never);

    const result = await searchGraphUsers({
      token: "token-2",
      query: "alice.o'hara@example.com",
    });

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "token-2",
      path: "/users?$filter=(mail%20eq%20'alice.o''hara%40example.com'%20or%20userPrincipalName%20eq%20'alice.o''hara%40example.com')&$select=id,displayName,mail,userPrincipalName",
    });
    expect(result).toEqual([{ id: "user-1", displayName: "User One" }]);
  });

  it("uses displayName search with eventual consistency and custom top", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({
      value: [{ id: "user-2", displayName: "Bob" }],
    } as never);

    const result = await searchGraphUsers({
      token: "token-3",
      query: "bob",
      top: 25,
    });

    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "token-3",
      path: "/users?$search=%22displayName%3Abob%22&$select=id,displayName,mail,userPrincipalName&$top=25",
      headers: { ConsistencyLevel: "eventual" },
    });
    expect(result).toEqual([{ id: "user-2", displayName: "Bob" }]);
  });

  it("falls back to default top and empty value handling", async () => {
    vi.mocked(fetchGraphJson).mockResolvedValueOnce({} as never);

    await expect(searchGraphUsers({ token: "token-4", query: "carol" })).resolves.toEqual([]);
    expect(fetchGraphJson).toHaveBeenCalledWith({
      token: "token-4",
      path: "/users?$search=%22displayName%3Acarol%22&$select=id,displayName,mail,userPrincipalName&$top=10",
      headers: { ConsistencyLevel: "eventual" },
    });
  });
});
