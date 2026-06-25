// Covers MCP OAuth token persistence, isolation, and noninteractive behavior.
import fs from "node:fs/promises";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  clearMcpOAuthCredentials,
  createMcpOAuthClientProvider,
  runMcpOAuthLogin,
} from "./mcp-oauth.js";

const authMock = vi.hoisted(() => vi.fn());

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: authMock,
}));

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
        });

        // Token files live under state, not workspace config, and are mode
        // 0600 because they contain bearer credentials.
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

  it("returns stored rotated tokens instead of replaying a stale refresh token", async () => {
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
          new URL("https://auth.example.com/token"),
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

  it("serializes concurrent refreshes so rotating refresh tokens are not replayed", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "Bearer",
        });

        const fetchFn = vi.fn(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
          return new Response(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });
        const wrappedFetch = provider.wrapFetchForTokenRefresh(fetchFn);
        const refreshInit = () => ({
          method: "POST",
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: "old-refresh",
          }),
        });

        const [first, second] = await Promise.all([
          wrappedFetch(new URL("https://auth.example.com/token"), refreshInit()),
          wrappedFetch(new URL("https://auth.example.com/token"), refreshInit()),
        ]);

        await expect(first.json()).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
        await expect(second.json()).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
        expect(fetchFn).toHaveBeenCalledOnce();
        await expect(provider.tokens()).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-concurrent-refresh-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("preserves OAuth metadata saved while a refresh is in flight", async () => {
    await withTempHome(
      async () => {
        const provider = createMcpOAuthClientProvider({
          serverName: "Remote Docs",
          serverUrl: "https://mcp.example.com/mcp",
        });
        await provider.saveTokens({
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "Bearer",
        });

        let resolveRefresh: (() => void) | undefined;
        const fetchFn = vi.fn(async () => {
          await new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          });
          return new Response(
            JSON.stringify({
              access_token: "new-access",
              refresh_token: "new-refresh",
              token_type: "Bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });

        const pendingRefresh = provider.wrapFetchForTokenRefresh(fetchFn)(
          new URL("https://auth.example.com/token"),
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "old-refresh",
            }),
          },
        );
        await vi.waitFor(() => {
          expect(fetchFn).toHaveBeenCalledOnce();
        });

        expect(provider.saveClientInformation).toBeDefined();
        await provider.saveClientInformation?.({ client_id: "client-after-refresh-started" });
        expect(resolveRefresh).toBeDefined();
        resolveRefresh?.();
        await expect(pendingRefresh.then((response) => response.json())).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });

        expect(await provider.clientInformation()).toMatchObject({
          client_id: "client-after-refresh-started",
        });
        await expect(provider.tokens()).resolves.toMatchObject({
          access_token: "new-access",
          refresh_token: "new-refresh",
        });
      },
      {
        prefix: "openclaw-mcp-oauth-refresh-store-merge-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("releases the refresh lock when the token endpoint exceeds the refresh deadline", async () => {
    vi.useFakeTimers();
    try {
      await withTempHome(
        async () => {
          const provider = createMcpOAuthClientProvider({
            serverName: "Remote Docs",
            serverUrl: "https://mcp.example.com/mcp",
          });
          await provider.saveTokens({
            access_token: "old-access",
            refresh_token: "old-refresh",
            token_type: "Bearer",
          });

          const fetchFn = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise<Response>(() => {
                  // Simulates a provider that never completes the refresh request.
                }),
            )
            .mockResolvedValueOnce(
              new Response(
                JSON.stringify({
                  access_token: "new-access",
                  refresh_token: "new-refresh",
                  token_type: "Bearer",
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          const wrappedFetch = provider.wrapFetchForTokenRefresh(fetchFn);
          const refreshInit = () => ({
            method: "POST",
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "old-refresh",
            }),
          });

          const stalledRefresh = wrappedFetch(
            new URL("https://auth.example.com/token"),
            refreshInit(),
          );
          await vi.waitFor(() => {
            expect(fetchFn).toHaveBeenCalledOnce();
          });
          await vi.advanceTimersByTimeAsync(90_000);
          await expect(stalledRefresh).rejects.toThrow(/timed out refreshing/i);

          const recoveredRefresh = await wrappedFetch(
            new URL("https://auth.example.com/token"),
            refreshInit(),
          );
          await expect(recoveredRefresh.json()).resolves.toMatchObject({
            access_token: "new-access",
            refresh_token: "new-refresh",
          });
          expect(fetchFn).toHaveBeenCalledTimes(2);
        },
        {
          prefix: "openclaw-mcp-oauth-refresh-deadline-",
          skipSessionCleanup: true,
          env: {
            OPENCLAW_CONFIG_PATH: undefined,
            OPENCLAW_STATE_DIR: undefined,
          },
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the legacy loopback redirect as the default for upgrade compatibility", () => {
    const provider = createMcpOAuthClientProvider({
      serverName: "Calendly",
      serverUrl: "https://mcp.calendly.com/",
    });

    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:8989/oauth/callback"]);
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8989/oauth/callback");
  });

  it("retries MCP OAuth login with localhost after redirect registration rejection", async () => {
    authMock.mockReset();
    authMock
      .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
      .mockResolvedValueOnce("AUTHORIZED");

    await expect(
      runMcpOAuthLogin({
        serverName: "Calendly",
        serverUrl: "https://mcp.calendly.com/",
      }),
    ).resolves.toBe("authorized");

    expect(authMock).toHaveBeenCalledTimes(2);
    expect(authMock.mock.calls[1]?.[0]?.clientMetadata.redirect_uris).toEqual([
      "http://localhost:8989/oauth/callback",
    ]);
  });

  it("does not retry a code exchange redirect mismatch", async () => {
    authMock.mockReset();
    authMock.mockRejectedValueOnce(new Error("invalid_grant: redirect_uri mismatch"));

    await expect(
      runMcpOAuthLogin({
        serverName: "Calendly",
        serverUrl: "https://mcp.calendly.com/",
        authorizationCode: "code-123",
      }),
    ).rejects.toThrow("redirect_uri mismatch");

    expect(authMock).toHaveBeenCalledOnce();
  });

  it("does not persist localhost when the fallback attempt fails", async () => {
    await withTempHome(
      async (home) => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockRejectedValueOnce(new Error("localhost redirect also rejected"));

        await expect(
          runMcpOAuthLogin({
            serverName: "Calendly",
            serverUrl: "https://mcp.calendly.com/",
          }),
        ).rejects.toThrow("localhost redirect also rejected");

        await expect(fs.readdir(`${home}/.openclaw/mcp-oauth`)).rejects.toThrow();
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-failure-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("persists localhost redirect for a later code exchange login", async () => {
    await withTempHome(
      async (home) => {
        authMock.mockReset();
        authMock
          .mockRejectedValueOnce(new Error("invalid_client_metadata: redirect_uri rejected"))
          .mockImplementationOnce(async (provider) => {
            await provider.saveCodeVerifier?.("verifier");
            return "REDIRECT";
          });

        await expect(
          runMcpOAuthLogin({
            serverName: "Calendly",
            serverUrl: "https://mcp.calendly.com/",
            onAuthorizationUrl: () => {},
          }),
        ).resolves.toBe("redirect");

        const tokenDir = `${home}/.openclaw/mcp-oauth`;
        const entries = await fs.readdir(tokenDir);
        const store = JSON.parse(await fs.readFile(`${tokenDir}/${entries[0]}`, "utf-8")) as {
          codeVerifier?: string;
          redirectUrl?: string;
        };
        expect(store.redirectUrl).toBe("http://localhost:8989/oauth/callback");
        expect(store.codeVerifier).toBe("verifier");

        authMock.mockReset();
        authMock.mockResolvedValueOnce("AUTHORIZED");
        await runMcpOAuthLogin({
          serverName: "Calendly",
          serverUrl: "https://mcp.calendly.com/",
          authorizationCode: "code-123",
        });
        expect(authMock.mock.calls[0]?.[0]?.clientMetadata.redirect_uris).toEqual([
          "http://localhost:8989/oauth/callback",
        ]);
      },
      {
        prefix: "openclaw-mcp-oauth-localhost-persist-",
        skipSessionCleanup: true,
        env: {
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_STATE_DIR: undefined,
        },
      },
    );
  });

  it("does not start hidden authorization flows without an authorization callback", async () => {
    // Normal agent/tool execution must not open browser auth flows implicitly;
    // operators use the explicit mcp login command instead.
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
