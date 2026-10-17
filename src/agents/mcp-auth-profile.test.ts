import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMcpBearerBundleConfig } from "./mcp-auth-profile.js";
import * as mcpHttpFetch from "./mcp-http-fetch.js";

// Profile refresh/projection and origin isolation use real owners in mcp-auth-profile.integration.test.ts.
const authMocks = vi.hoisted(() => ({
  loadAuthProfileStoreForRuntimeAsync: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

// mock-isolation: Bearer projection uses synthetic profile snapshots without reading host stores.
vi.mock("./auth-profiles/store-runtime.js", () => ({
  loadAuthProfileStoreForRuntimeAsync: authMocks.loadAuthProfileStoreForRuntimeAsync,
}));

vi.mock("./auth-profiles/oauth.js", () => ({
  resolveApiKeyForProfile: authMocks.resolveApiKeyForProfile,
}));

vi.mock("./mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

const envBearer = expect.stringMatching(/^Bearer \$\{OPENCLAW_MCP_AUTH_[A-F0-9]{12}_TOKEN}$/);

describe("mcp auth profile bearer projection", () => {
  beforeEach(() => {
    authMocks.loadAuthProfileStoreForRuntimeAsync.mockReset();
    authMocks.resolveApiKeyForProfile.mockReset();
    authMocks.resolveMcpOAuthAccessToken.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects existing MCP-native OAuth credentials without an auth profile", async () => {
    const buildMcpOAuthAuthorizationFetch = vi.spyOn(
      mcpHttpFetch,
      "buildMcpOAuthAuthorizationFetch",
    );
    authMocks.resolveMcpOAuthAccessToken.mockResolvedValueOnce("native-access-token");

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          docs: {
            url: "https://mcp.example.com/mcp",
            type: "http",
            auth: "oauth",
            oauth: { scope: "docs.read" },
            requestTimeoutMs: 25,
          },
        },
      },
    });

    expect(resolved.config.mcpServers.docs).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: envBearer },
    });
    expect(resolved.config.mcpServers.docs?.auth).toBeUndefined();
    expect(resolved.config.mcpServers.docs?.oauth).toBeUndefined();
    expect(Object.values(resolved.env ?? {})).toEqual(["native-access-token"]);
    expect(buildMcpOAuthAuthorizationFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://mcp.example.com/mcp",
        requestTimeoutMs: 25,
        headers: undefined,
      }),
    );
    expect(authMocks.resolveMcpOAuthAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com/mcp",
        }),
        config: { scope: "docs.read" },
        fetchFn: expect.any(Function),
      }),
    );
  });

  it("omits unavailable OAuth servers when graceful degradation is requested", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const onServerUnavailable = vi.fn();

    const resolved = await resolveMcpBearerBundleConfig({
      config: {
        mcpServers: {
          gbrain: { url: "https://gbrain.example.com/mcp", type: "http", auth: "oauth" },
          localTools: { command: "local-tools" },
        },
      },
      omitUnavailableOAuthServers: true,
      onServerUnavailable,
    });

    expect(resolved.config.mcpServers).toStrictEqual({
      localTools: { command: "local-tools" },
    });
    expect(onServerUnavailable).toHaveBeenCalledWith("gbrain", expect.any(Error));
  });
});
