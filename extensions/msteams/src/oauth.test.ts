// Msteams tests cover oauth plugin behavior.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
      fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    }) => {
      const fetchImpl = params.fetchImpl ?? globalThis.fetch;
      const response = await fetchImpl(params.url, params.init);
      return {
        response,
        finalUrl: params.url,
        release: async () => {},
      };
    },
  ),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import { buildMSTeamsAuthUrl } from "./oauth.flow.js";
import { loginMSTeamsDelegated } from "./oauth.js";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsAuthEndpoint,
  buildMSTeamsTokenEndpoint,
} from "./oauth.shared.js";
import { exchangeMSTeamsCodeForTokens, refreshMSTeamsDelegatedTokens } from "./oauth.token.js";

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function firstFetchCall(fetchSpy: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const [call] = fetchSpy.mock.calls;
  if (!call) {
    throw new Error("expected fetch call");
  }
  return call as [string, RequestInit];
}

describe("manual delegated sign-in", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["valid", "missing", "mismatched"])(
    "exchanges the code only for a %s callback state",
    async (stateKind) => {
      const fetchSpy = vi.fn(async () =>
        responseJson({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
      vi.stubGlobal("fetch", fetchSpy);
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
      const [url, init] = firstFetchCall(fetchSpy);
      expect(url).toBe(buildMSTeamsTokenEndpoint("tenant"));
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("client");
      expect(body.get("client_secret")).toBe("synthetic-client-secret");
      expect(body.get("redirect_uri")).toBe(MSTEAMS_OAUTH_REDIRECT_URI);
      expect(body.get("code")).toBe("callback-code");
      expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
        authUrl!.searchParams.get("code_challenge"),
      );
    },
  );
});

describe("buildMSTeamsAuthUrl", () => {
  it("includes correct tenant, client_id, scopes, PKCE params, and redirect_uri", () => {
    const challenge = "challenge-value";
    const state = "state-value";
    const url = buildMSTeamsAuthUrl({
      tenantId: "my-tenant-id",
      clientId: "my-client-id",
      challenge,
      state,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(buildMSTeamsAuthEndpoint("my-tenant-id"));
    expect(parsed.searchParams.get("client_id")).toBe("my-client-id");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(MSTEAMS_OAUTH_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe(MSTEAMS_DEFAULT_DELEGATED_SCOPES.join(" "));
    expect(parsed.searchParams.get("code_challenge")).toBe(challenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(state);
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("uses custom scopes when provided", () => {
    const url = buildMSTeamsAuthUrl({
      tenantId: "t",
      clientId: "c",
      challenge: "ch",
      state: "s",
      scopes: ["User.Read", "offline_access"],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("User.Read offline_access");
  });
});

describe("exchangeMSTeamsCodeForTokens", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on a 400 error response", async () => {
    fetchSpy.mockResolvedValueOnce(Response.json({ error: "invalid_grant" }, { status: 400 }));

    await expect(
      exchangeMSTeamsCodeForTokens({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s", // pragma: allowlist secret
        code: "bad-code",
        verifier: "v",
      }),
    ).rejects.toThrow(/MSTeams token exchange failed \(400\)/);
  });

  it("rejects unsafe token exchange expiry values", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"access_token":"at-unsafe","refresh_token":"rt-unsafe","expires_in":1e309}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      exchangeMSTeamsCodeForTokens({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s", // pragma: allowlist secret
        code: "unsafe-expiry",
        verifier: "v",
      }),
    ).rejects.toThrow("MSTeams token exchange failed: invalid token response fields");
  });

  it("rejects a top-level null token exchange response", async () => {
    fetchSpy.mockResolvedValueOnce(responseJson(null));

    await expect(
      exchangeMSTeamsCodeForTokens({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s", // pragma: allowlist secret
        code: "invalid-shape",
        verifier: "v",
      }),
    ).rejects.toThrow("MSTeams token exchange failed: invalid token response fields");
  });
});

describe("refreshMSTeamsDelegatedTokens", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes tokens using refresh_token grant and keeps old refresh token when Azure omits it", async () => {
    const now = Date.now();
    fetchSpy.mockResolvedValueOnce(
      responseJson({
        access_token: "new-at",
        // Azure sometimes does not return a new refresh_token
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

    expect(tokens.accessToken).toBe("new-at");
    // Old refresh token should be preserved
    expect(tokens.refreshToken).toBe("original-rt");
    expect(tokens.scopes).toEqual(["ChatMessage.Send", "offline_access"]);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(now + 3300 * 1000 - 1000);

    // Verify the request body includes refresh_token grant type
    const [, init] = firstFetchCall(fetchSpy);
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("original-rt");
    expect(body.get("client_secret")).toBe("secret-1");
  });

  it("uses new refresh token when Azure returns one", async () => {
    fetchSpy.mockResolvedValueOnce(
      responseJson({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 3600,
      }),
    );

    const tokens = await refreshMSTeamsDelegatedTokens({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s", // pragma: allowlist secret
      refreshToken: "old-rt",
    });

    expect(tokens.refreshToken).toBe("new-rt");
  });
});
