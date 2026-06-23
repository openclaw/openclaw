/** Tests auth-profile backed MCP bearer projection. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpAuthProfileBundleConfig, withMcpAuthProfileBearer } from "./mcp-auth-profile.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
}));

vi.mock("./auth-profiles.js", () => ({
  loadAuthProfileStoreForSecretsRuntime: authMocks.loadAuthProfileStoreForSecretsRuntime,
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

describe("mcp auth profile bearer projection", () => {
  beforeEach(() => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    authMocks.resolveApiKeyForProfile.mockReset();
  });

  it("resolves refreshable OAuth profiles into env-backed CLI bearer headers", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
      credential: {
        type: "oauth",
        provider: "ducktape",
        access: "fresh-access-token",
        refresh: "refresh-token-must-not-project",
        expires: Date.now() + 60_000,
      },
    });

    const resolved = await resolveMcpAuthProfileBundleConfig({
      config: {
        mcpServers: {
          ducktape: {
            url: "https://agents.ducktape.xyz/mcp",
            type: "http",
            auth: "oauth",
            oauth: { authProfileId: "ducktape:mcp" },
            headers: {
              Authorization: "Bearer stale-access",
              "X-Trace": "keep",
            },
          },
        },
      },
    });

    const server = resolved.config.mcpServers.ducktape;
    expect(server.auth).toBeUndefined();
    expect(server.oauth).toBeUndefined();
    expect(server.headers).toEqual({
      Authorization: expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/),
      "X-Trace": "keep",
    });
    expect(JSON.stringify(resolved.config)).not.toContain("refresh-token-must-not-project");
    expect(JSON.stringify(resolved.env)).not.toContain("refresh-token-must-not-project");
    expect(Object.values(resolved.env ?? {})).toEqual(["fresh-access-token"]);
    expect(authMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "ducktape:mcp",
      }),
    );
  });

  it("rejects static token profiles instead of pretending they are refreshable", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValueOnce({
      version: 1,
      profiles: {
        "ducktape:static": {
          type: "token",
          provider: "ducktape",
          token: "expired-static-token",
          expires: 1,
        },
      },
    });

    await expect(
      resolveMcpAuthProfileBundleConfig({
        config: {
          mcpServers: {
            ducktape: {
              url: "https://agents.ducktape.xyz/mcp",
              auth: "oauth",
              oauth: { authProfileId: "ducktape:static" },
            },
          },
        },
      }),
    ).rejects.toThrow("profiles are not refreshable");
  });

  it("injects fresh bearer headers only for same-origin embedded MCP requests", async () => {
    authMocks.loadAuthProfileStoreForSecretsRuntime.mockReturnValue({
      version: 1,
      profiles: {
        "ducktape:mcp": {
          type: "oauth",
          provider: "ducktape",
          access: "expired-access",
          refresh: "refresh-token-must-not-project",
          expires: 1,
        },
      },
    });
    authMocks.resolveApiKeyForProfile.mockResolvedValue({
      apiKey: "fresh-access-token",
      provider: "ducktape",
      profileId: "ducktape:mcp",
      profileType: "oauth",
    });
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const wrapped = withMcpAuthProfileBearer({
      fetchFn: async (url, init) => {
        calls.push([url, init]);
        return new Response("ok");
      },
      serverName: "ducktape",
      resourceUrl: "https://agents.ducktape.xyz/mcp",
      authProfileId: "ducktape:mcp",
      headers: {
        Authorization: "Bearer stale-access",
        "X-Trace": "keep",
      },
    });

    await wrapped("https://agents.ducktape.xyz/mcp", {
      headers: { Accept: "application/json", Authorization: "Bearer sdk-stale" },
    });
    await wrapped("https://redirect.example/mcp", {
      headers: { Authorization: "Bearer sdk-stale" },
    });

    const sameOriginHeaders = new Headers(calls[0]?.[1]?.headers);
    expect(sameOriginHeaders.get("authorization")).toBe("Bearer fresh-access-token");
    expect(sameOriginHeaders.get("x-trace")).toBe("keep");
    expect(sameOriginHeaders.get("accept")).toBe("application/json");
    expect(calls[1]?.[1]?.headers).toEqual({ Authorization: "Bearer sdk-stale" });
  });
});
