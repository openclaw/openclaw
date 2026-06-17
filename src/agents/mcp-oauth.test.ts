import fs from "node:fs/promises";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  clearMcpOAuthCredentials,
  createMcpOAuthClientProvider,
  readMcpOAuthCredentialsStatus,
} from "./mcp-oauth.js";

describe("MCP OAuth provider", () => {
  it("stores token state under the OpenClaw state directory with restricted permissions", async () => {
    await withTempHome(
      async (home) => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        await expect(provider.tokens()).resolves.toEqual({
          access_token: "access",
          token_type: "Bearer",
          obtained_at: expect.any(Number),
        });

        const tokenDir = `${home}/.openclaw/mcp-oauth`;
        const entries = await fs.readdir(tokenDir);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^Remote-Docs-[a-f0-9]{16}\.json$/);
        const tokenPath = `${tokenDir}/${entries[0]}`;
        const stat = await fs.stat(tokenPath);
        expect(stat.mode & 0o777).toBe(0o600);
      },
      {
        prefix: "openclaw-mcp-oauth-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("records token expiry metadata when OAuth responses include expires_in", async () => {
    await withTempHome(
      async () => {
        const before = Math.floor(Date.now() / 1000);
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });

        await provider.saveTokens({
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });

        const tokens = (await provider.tokens()) as { obtained_at?: number; expires_at?: number };
        expect(tokens?.obtained_at).toBeGreaterThanOrEqual(before);
        expect(tokens?.expires_at).toBeGreaterThanOrEqual(before + 3600);
        await expect(
          readMcpOAuthCredentialsStatus({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).resolves.toMatchObject({
          hasTokens: true,
          tokenExpiresAt: expect.any(Number),
          requiresReauthorization: false,
        });
      },
      {
        prefix: "openclaw-mcp-oauth-expiry-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("isolates token state by configured server URL", async () => {
    await withTempHome(
      async () => {
        const first = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        const second = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://other.example.com/mcp",
        });
        await first.saveTokens({ access_token: "access", token_type: "Bearer" });

        await expect(second.tokens()).resolves.toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-url-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not start hidden authorization flows without an authorization callback", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });

        await expect(provider.state?.()).rejects.toThrow("Run openclaw mcp login Remote Docs.");
        await expect(provider.saveCodeVerifier?.("verifier")).rejects.toThrow(
          "Run openclaw mcp login Remote Docs.",
        );
        await expect(
          provider.redirectToAuthorization?.(new URL("https://auth.example.com/authorize")),
        ).rejects.toThrow("Run openclaw mcp login Remote Docs.");
      },
      {
        prefix: "openclaw-mcp-oauth-noninteractive-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("returns the latest stored tokens instead of replaying a stale rotating refresh token", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "new-access",
          refresh_token: "new-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
        const fetchFn = vi.fn(async () => {
          return new Response(
            JSON.stringify({
              access_token: "replayed-access",
              refresh_token: "replayed-refresh",
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });

        const response = await provider.wrapFetchForTokenRefresh(fetchFn)(
          new URL("https://mcp.example.com/token"),
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "old-refresh",
            }),
          },
        );

        await expect(response.json()).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
        expect(fetchFn).not.toHaveBeenCalled();
      },
      {
        prefix: "openclaw-mcp-oauth-stale-refresh-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("marks token invalidation as requiring reauthorization", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
        });

        await provider.invalidateCredentials?.("tokens");

        await expect(provider.tokens()).resolves.toBeUndefined();
        await expect(
          readMcpOAuthCredentialsStatus({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          }),
        ).resolves.toMatchObject({
          hasTokens: false,
          lastErrorCode: "invalid_grant",
          requiresReauthorization: true,
        });
      },
      {
        prefix: "openclaw-mcp-oauth-invalid-grant-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("clears stored credentials for a configured server URL", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({ access_token: "access", token_type: "Bearer" });

        await clearMcpOAuthCredentials({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });

        await expect(provider.tokens()).resolves.toBeUndefined();
      },
      {
        prefix: "openclaw-mcp-oauth-clear-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });
});
