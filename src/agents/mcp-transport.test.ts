import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMcpTransport } from "./mcp-transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveMcpTransport", () => {
  it("passes the OAuth provider through to streamable HTTP transports", () => {
    const authProvider = {
      get redirectUrl() {
        return "http://127.0.0.1:8093/mcp/callback";
      },
      get clientMetadata() {
        return {
          redirect_uris: ["http://127.0.0.1:8093/mcp/callback"],
          token_endpoint_auth_method: "none" as const,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "OpenClaw test",
        };
      },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
    };

    const resolved = resolveMcpTransport(
      "oauth-http",
      {
        url: "https://mcp.example.com/http",
        transport: "streamable-http",
        auth: "oauth",
      },
      { authProvider },
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.auth).toBe("oauth");
    expect((resolved!.transport as { _authProvider?: unknown })._authProvider).toBe(authProvider);
  });

  it("passes the OAuth provider through to SSE transports", () => {
    const authProvider = {
      get redirectUrl() {
        return "http://127.0.0.1:8093/mcp/callback";
      },
      get clientMetadata() {
        return {
          redirect_uris: ["http://127.0.0.1:8093/mcp/callback"],
          token_endpoint_auth_method: "none" as const,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "OpenClaw test",
        };
      },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
    };

    const resolved = resolveMcpTransport(
      "oauth-sse",
      {
        url: "https://mcp.example.com/sse",
        auth: "oauth",
      },
      { authProvider },
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.auth).toBe("oauth");
    expect((resolved!.transport as { _authProvider?: unknown })._authProvider).toBe(authProvider);
  });

  it("keeps SDK OAuth headers when the SSE event-source fetch receives header tuples", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const authProvider = {
      get redirectUrl() {
        return "http://127.0.0.1:8093/mcp/callback";
      },
      get clientMetadata() {
        return {
          redirect_uris: ["http://127.0.0.1:8093/mcp/callback"],
          token_endpoint_auth_method: "none" as const,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "OpenClaw test",
        };
      },
      clientInformation: () => undefined,
      tokens: () =>
        ({
          access_token: "oauth-access-token",
          token_type: "Bearer",
        }) as const,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
    };

    const resolved = resolveMcpTransport(
      "oauth-sse",
      {
        url: "https://mcp.example.com/sse",
        auth: "oauth",
        headers: {
          "X-Custom": "custom-value",
        },
      },
      { authProvider },
    );

    const transport = resolved?.transport as {
      _eventSourceInit?: { fetch?: (url: string, init?: RequestInit) => Promise<Response> };
    };

    await transport._eventSourceInit?.fetch?.("https://mcp.example.com/sse", {
      headers: [
        ["authorization", "Bearer oauth-access-token"],
        ["accept", "text/event-stream"],
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith("https://mcp.example.com/sse", {
      headers: {
        authorization: "Bearer oauth-access-token",
        accept: "text/event-stream",
        "X-Custom": "custom-value",
      },
    });
  });

  it("does not attach an auth provider when OAuth is not configured", () => {
    const authProvider = {
      get redirectUrl() {
        return "http://127.0.0.1:8093/mcp/callback";
      },
      get clientMetadata() {
        return {
          redirect_uris: ["http://127.0.0.1:8093/mcp/callback"],
          token_endpoint_auth_method: "none" as const,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: "OpenClaw test",
        };
      },
      clientInformation: () => undefined,
      tokens: () => undefined,
      saveTokens: () => undefined,
      redirectToAuthorization: () => undefined,
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "verifier",
    };

    const resolved = resolveMcpTransport(
      "plain-http",
      {
        url: "https://mcp.example.com/http",
        transport: "streamable-http",
      },
      { authProvider },
    );

    expect(resolved).not.toBeNull();
    expect(resolved?.auth).toBeUndefined();
    expect((resolved!.transport as { _authProvider?: unknown })._authProvider).toBeUndefined();
  });
});
