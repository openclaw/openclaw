import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// mock-isolation: Exercise OAuth against the supplied fetch fixture without external network access.
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
      fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    }) => {
      const fetchImpl = params.fetchImpl ?? globalThis.fetch;
      const response = await fetchImpl(params.url, params.init);
      return { response, finalUrl: params.url, release: async () => {} };
    },
  ),
}));

import { loginMSTeamsDelegated } from "./oauth.js";
import { MSTEAMS_OAUTH_REDIRECT_URI, buildMSTeamsTokenEndpoint } from "./oauth.shared.js";
import { exchangeMSTeamsCodeForTokens, refreshMSTeamsDelegatedTokens } from "./oauth.token.js";

function firstFetchCall(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [call] = fetchMock.mock.calls;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call as [string, RequestInit];
}

const credentials = { tenantId: "t", clientId: "c", clientSecret: "s" }; // pragma: allowlist secret
let fetchSpy: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchSpy = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("manual delegated sign-in", () => {
  it.each(["valid", "missing", "mismatched"])(
    "exchanges the code only for a %s callback state",
    async (stateKind) => {
      fetchSpy.mockImplementation(async () =>
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
      let authUrl: URL | undefined;
      const login = loginMSTeamsDelegated(
        {
          note: vi.fn(async () => {}),
          log: (message) => {
            authUrl = new URL(message.match(/https:\/\/\S+/u)![0]);
          },
          prompt: async () => {
            const callback = new URL(MSTEAMS_OAUTH_REDIRECT_URI);
            callback.searchParams.set("code", "callback-code");
            if (stateKind !== "missing") {
              callback.searchParams.set(
                "state",
                stateKind === "valid" ? authUrl!.searchParams.get("state")! : "wrong-state",
              );
            }
            return callback.toString();
          },
          progress: { update: vi.fn(), stop: vi.fn() },
        },
        {
          tenantId: "tenant",
          clientId: "client",
          clientSecret: "synthetic-client-secret", // pragma: allowlist secret
        },
      );
      if (stateKind !== "valid") {
        await expect(login).rejects.toThrow(/state/u);
        expect(fetchSpy).not.toHaveBeenCalled();
        return;
      }
      await expect(login).resolves.toMatchObject({
        accessToken: "access",
        refreshToken: "refresh",
      });
      expect(authUrl!.origin + authUrl!.pathname).toBe(
        "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize",
      );
      expect(Object.fromEntries(authUrl!.searchParams)).toMatchObject({
        client_id: "client",
        response_type: "code",
        redirect_uri: "http://localhost:8086/oauth2callback",
        scope: "ChatMessage.Send ChannelMessage.Send Chat.ReadWrite offline_access",
        code_challenge_method: "S256",
        prompt: "consent",
      });
      const [url, init] = firstFetchCall(fetchSpy);
      expect(url).toBe(buildMSTeamsTokenEndpoint("tenant"));
      const body = new URLSearchParams(init.body as string);
      expect(Object.fromEntries(body)).toMatchObject({
        grant_type: "authorization_code",
        client_id: "client",
        client_secret: "synthetic-client-secret", // pragma: allowlist secret
        redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
        code: "callback-code",
      });
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
        authUrl!.searchParams.get("code_challenge"),
      );
      expect(authUrl!.searchParams.get("state")).not.toBe(body.get("code_verifier"));
    },
  );
});

describe("exchangeMSTeamsCodeForTokens", () => {
  it.each([
    [
      "bad-code",
      () => Response.json({ error: "invalid_grant" }, { status: 400 }),
      /MSTeams token exchange failed \(400\)/,
    ],
    [
      "unsafe-expiry",
      () =>
        new Response(
          '{"access_token":"at-unsafe","refresh_token":"rt-unsafe","expires_in":1e309}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      "MSTeams token exchange failed: invalid token response fields",
    ],
    [
      "invalid-shape",
      () => Response.json(null),
      "MSTeams token exchange failed: invalid token response fields",
    ],
  ] as const)("rejects token exchange: %s", async (code, response, error) => {
    fetchSpy.mockResolvedValueOnce(response());
    await expect(
      exchangeMSTeamsCodeForTokens({ ...credentials, code, verifier: "v" }),
    ).rejects.toThrow(error);
  });
});

describe("refreshMSTeamsDelegatedTokens", () => {
  it("refreshes tokens using refresh_token grant and keeps old refresh token when Azure omits it", async () => {
    const now = Date.now();
    fetchSpy.mockResolvedValueOnce(
      Response.json({
        access_token: "new-at",
        expires_in: 3600,
        scope: "ChatMessage.Send offline_access",
      }),
    );

    const tokens = await refreshMSTeamsDelegatedTokens({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1", // pragma: allowlist secret
      refreshToken: "original-rt",
    });

    expect(tokens).toMatchObject({
      accessToken: "new-at",
      refreshToken: "original-rt",
      scopes: ["ChatMessage.Send", "offline_access"],
    });
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(now + 3300 * 1000 - 1000);

    const [, init] = firstFetchCall(fetchSpy);
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "original-rt",
      client_secret: "secret-1", // pragma: allowlist secret
    });
  });

  it("uses new refresh token when Azure returns one", async () => {
    fetchSpy.mockResolvedValueOnce(
      Response.json({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }),
    );

    const tokens = await refreshMSTeamsDelegatedTokens({ ...credentials, refreshToken: "old-rt" });

    expect(tokens.refreshToken).toBe("new-rt");
  });
});
