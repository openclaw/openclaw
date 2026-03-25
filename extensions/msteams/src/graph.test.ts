import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProviderMock,
  readAccessTokenMock,
  resolveMSTeamsCredentialsMock,
} = vi.hoisted(() => {
  return {
    loadMSTeamsSdkWithAuthMock: vi.fn(),
    createMSTeamsTokenProviderMock: vi.fn(),
    readAccessTokenMock: vi.fn(),
    resolveMSTeamsCredentialsMock: vi.fn(),
  };
});

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProvider: createMSTeamsTokenProviderMock,
}));

vi.mock("./token-response.js", () => ({
  readAccessToken: readAccessTokenMock,
}));

vi.mock("./token.js", () => ({
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

import { searchGraphUsers } from "./graph-users.js";
import {
  escapeOData,
  fetchGraphJson,
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  resolveGraphToken,
} from "./graph.js";

const originalFetch = globalThis.fetch;

describe("msteams graph helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes queries and escapes OData apostrophes", () => {
    expect(normalizeQuery("  Team Alpha  ")).toBe("Team Alpha");
    expect(normalizeQuery("   ")).toBe("");
    expect(escapeOData("alice.o'hara")).toBe("alice.o''hara");
  });

  it("fetches Graph JSON and surfaces Graph errors with response text", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ value: [{ id: "group-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(
      fetchGraphJson<{ value: Array<{ id: string }> }>({
        token: "graph-token",
        path: "/groups?$select=id",
        headers: { ConsistencyLevel: "eventual" },
      }),
    ).resolves.toEqual({ value: [{ id: "group-1" }] });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/groups?$select=id",
      {
        headers: expect.objectContaining({
          Authorization: "Bearer graph-token",
          ConsistencyLevel: "eventual",
        }),
      },
    );

    globalThis.fetch = vi.fn(async () => {
      return new Response("forbidden", { status: 403 });
    }) as typeof fetch;

    await expect(
      fetchGraphJson({
        token: "graph-token",
        path: "/teams/team-1/channels",
      }),
    ).rejects.toThrow("Graph /teams/team-1/channels failed (403): forbidden");
  });

  it("resolves Graph tokens through the SDK auth provider", async () => {
    const getAccessToken = vi.fn(async () => "raw-graph-token");
    const mockApp = { id: "mock-app" };

    resolveMSTeamsCredentialsMock.mockReturnValue({
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: mockApp });
    createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
    readAccessTokenMock.mockReturnValue("resolved-token");

    await expect(resolveGraphToken({ channels: { msteams: {} } })).resolves.toBe("resolved-token");

    expect(createMSTeamsTokenProviderMock).toHaveBeenCalledWith(mockApp);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expect(resolveGraphToken({ channels: {} })).rejects.toThrow(
      "MS Teams credentials missing",
    );

    const getAccessToken = vi.fn(async () => null);
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: { id: "mock-app" } });
    createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
    resolveMSTeamsCredentialsMock.mockReturnValue({
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    readAccessTokenMock.mockReturnValue(null);

    await expect(resolveGraphToken({ channels: { msteams: {} } })).rejects.toThrow(
      "MS Teams graph token unavailable",
    );
  });

  it("builds encoded Graph paths for teams and channels", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/groups?")) {
        return new Response(JSON.stringify({ value: [{ id: "team-1", displayName: "Ops" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ value: [{ id: "chan-1", displayName: "Deployments" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;

    await expect(listTeamsByName("graph-token", "Bob's Team")).resolves.toEqual([
      { id: "team-1", displayName: "Ops" },
    ]);
    await expect(listChannelsForTeam("graph-token", "team/ops")).resolves.toEqual([
      { id: "chan-1", displayName: "Deployments" },
    ]);

    const calls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(calls[0]).toContain(
      "/groups?$filter=resourceProvisioningOptions%2FAny(x%3Ax%20eq%20'Team')%20and%20startsWith(displayName%2C'Bob''s%20Team')&$select=id,displayName",
    );
    expect(calls[1]).toContain("/teams/team%2Fops/channels?$select=id,displayName");
  });

  it("returns no graph users for blank queries", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(searchGraphUsers({ token: "token-1", query: "   " })).resolves.toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses exact mail or UPN lookup for email-like graph user queries", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ value: [{ id: "user-1", displayName: "User One" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await searchGraphUsers({
      token: "token-2",
      query: "alice.o'hara@example.com",
    });

    expect(result).toEqual([{ id: "user-1", displayName: "User One" }]);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain(
      "/users?$filter=(mail%20eq%20'alice.o''hara%40example.com'%20or%20userPrincipalName%20eq%20'alice.o''hara%40example.com')&$select=id,displayName,mail,userPrincipalName",
    );
  });

  it("uses displayName search with eventual consistency and default top handling", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("displayName%3Abob")) {
        return new Response(JSON.stringify({ value: [{ id: "user-2", displayName: "Bob" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await expect(searchGraphUsers({ token: "token-3", query: "bob", top: 25 })).resolves.toEqual([
      { id: "user-2", displayName: "Bob" },
    ]);
    await expect(searchGraphUsers({ token: "token-4", query: "carol" })).resolves.toEqual([]);

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(String(calls[0]?.[0])).toContain(
      "/users?$search=%22displayName%3Abob%22&$select=id,displayName,mail,userPrincipalName&$top=25",
    );
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ ConsistencyLevel: "eventual" }),
      }),
    );
    expect(String(calls[1]?.[0])).toContain(
      "/users?$search=%22displayName%3Acarol%22&$select=id,displayName,mail,userPrincipalName&$top=10",
    );
  });
});
