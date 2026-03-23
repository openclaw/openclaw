import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadMSTeamsSdkWithAuthMock, readAccessTokenMock, resolveMSTeamsCredentialsMock } =
  vi.hoisted(() => {
    return {
      loadMSTeamsSdkWithAuthMock: vi.fn(),
      readAccessTokenMock: vi.fn(),
      resolveMSTeamsCredentialsMock: vi.fn(),
    };
  });

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
}));

vi.mock("./token-response.js", () => ({
  readAccessToken: readAccessTokenMock,
}));

vi.mock("./token.js", () => ({
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

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

    await expect(fetchGraphJson<{ value: Array<{ id: string }> }>({
      token: "graph-token",
      path: "/groups?$select=id",
      headers: { ConsistencyLevel: "eventual" },
    })).resolves.toEqual({ value: [{ id: "group-1" }] });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/groups?$select=id",
      {
        headers: {
          Authorization: "Bearer graph-token",
          ConsistencyLevel: "eventual",
        },
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
    const getAccessToken = vi.fn(async () => ({ accessToken: "sdk-token" }));
    const MsalTokenProvider = vi.fn(function MockMsalTokenProvider() {
      return { getAccessToken };
    });

    resolveMSTeamsCredentialsMock.mockReturnValue({
      appId: "app-id",
      appPassword: "app-password",
      tenantId: "tenant-id",
    });
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({
      sdk: { MsalTokenProvider },
      authConfig: { clientId: "app-id" },
    });
    readAccessTokenMock.mockReturnValue("resolved-token");

    await expect(resolveGraphToken({ channels: { msteams: {} } })).resolves.toBe("resolved-token");

    expect(MsalTokenProvider).toHaveBeenCalledWith({ clientId: "app-id" });
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expect(resolveGraphToken({ channels: {} })).rejects.toThrow("MS Teams credentials missing");

    const getAccessToken = vi.fn(async () => ({ token: null }));
    loadMSTeamsSdkWithAuthMock.mockResolvedValue({
      sdk: {
        MsalTokenProvider: vi.fn(function MockMsalTokenProvider() {
          return { getAccessToken };
        }),
      },
      authConfig: { clientId: "app-id" },
    });
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
});
