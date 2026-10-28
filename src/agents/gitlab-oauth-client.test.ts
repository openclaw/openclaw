import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecoverableOAuthRefreshFailure } from "../shared/oauth-refresh-outcome.js";
import {
  createGitLabAuthorization,
  exchangeGitLabAuthorization,
  refreshGitLabAuthorization,
  verifyGitLabAccount,
  type GitLabOAuthConfig,
} from "./gitlab-oauth-client.js";

const config: GitLabOAuthConfig = {
  issuer: "https://gitlab.example.test",
  clientId: "public-client",
  redirectUri: "https://gateway.example.test/oauth/gitlab/callback",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = (overrides: Record<string, unknown> = {}) => ({
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh-next",
  token_type: "Bearer",
  expires_in: 7200,
  ...overrides,
});
const info = (scope: unknown = ["api", "write_repository"]) => ({ scope });
const account = (overrides: Record<string, unknown> = {}) => ({
  id: 99,
  username: "alice",
  name: "Alice Example",
  commit_email: "alice@example.test",
  bot: false,
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("GitLab personal OAuth client", () => {
  it("creates a PKCE authorization URL bound to the selected issuer and callback", () => {
    const result = createGitLabAuthorization(config);
    const url = new URL(result.url);
    expect(url.origin + url.pathname).toBe("https://gitlab.example.test/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(config.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("scope")).toBe("api write_repository");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(result.verifier).digest("base64url"),
    );
    expect(createGitLabAuthorization(config).state).not.toBe(result.state);
  });

  it("exchanges a code, proves scopes from token info and verifies a human account", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if ((url instanceof Request ? url.url : url.toString()).endsWith("/oauth/token")) {
        return respond(token({ scope: "api" }));
      }
      if ((url instanceof Request ? url.url : url.toString()).endsWith("/oauth/token/info")) {
        return respond(info());
      }
      return respond(account());
    });
    const authorization = createGitLabAuthorization(config);
    const tokens = await exchangeGitLabAuthorization(config, {
      code: "synthetic-code",
      verifier: authorization.verifier,
    });
    expect(tokens).toEqual({
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh-next",
      expiresAtMs: expect.any(Number),
      scopes: ["api", "write_repository"],
    });
    expect(await verifyGitLabAccount(config, tokens)).toEqual({
      accountId: 99,
      login: "alice",
      name: "Alice Example",
      commitEmail: "alice@example.test",
      issuer: config.issuer,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(
      fetchMock.mock.calls.map(
        ([url]) => new URL(url instanceof Request ? url.url : url.toString()).origin,
      ),
    ).toEqual([config.issuer, config.issuer, config.issuer, config.issuer]);
  });

  it("denies missing write scope even when the token response claims it", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(token({ scope: "api write_repository" })))
      .mockResolvedValueOnce(respond(info(["api"])));
    const authorization = createGitLabAuthorization(config);
    await expect(
      exchangeGitLabAuthorization(config, { code: "code", verifier: authorization.verifier }),
    ).rejects.toThrow("GitLab authorization failed");
  });

  it("refuses redirects and bot or missing commit identity", async () => {
    const authorization = createGitLabAuthorization(config);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 302 }));
    await expect(
      exchangeGitLabAuthorization(config, { code: "code", verifier: authorization.verifier }),
    ).rejects.toThrow("GitLab authorization failed");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(info()))
      .mockResolvedValueOnce(respond(account({ bot: true })))
      .mockResolvedValueOnce(respond(info()))
      .mockResolvedValueOnce(respond(account({ commit_email: null })));
    const tokens = {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAtMs: Date.now() + 7200000,
      scopes: ["api", "write_repository"],
    };
    await expect(verifyGitLabAccount(config, tokens)).rejects.toThrow("could not be verified");
    await expect(verifyGitLabAccount(config, tokens)).rejects.toThrow("could not be verified");
  });

  it("permits a verified bot actor only for an explicit managed caller", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(info()))
      .mockResolvedValueOnce(respond(account({ bot: true, username: "service-bot" })));
    const tokens = {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAtMs: Date.now() + 7200000,
      scopes: ["api", "write_repository"],
    };
    await expect(verifyGitLabAccount(config, tokens, { allowBot: true })).resolves.toMatchObject({
      login: "service-bot",
      commitEmail: "alice@example.test",
      issuer: config.issuer,
    });
  });

  it("rechecks authority after network wait and before token-info dispatch", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let current = true;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(pending);
    const authorization = createGitLabAuthorization(config);
    const exchange = exchangeGitLabAuthorization(config, {
      code: "code",
      verifier: authorization.verifier,
      assertCurrent: () => {
        if (!current) {
          throw new Error("retired");
        }
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    current = false;
    release(respond(token()));
    await expect(exchange).rejects.toThrow("GitLab authorization failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies refresh rejection and an uncertain post-token failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond({ error: "invalid_grant" }, 400))
      .mockResolvedValueOnce(respond(token()))
      .mockResolvedValueOnce(respond(info(["api"])));
    const rejected = await refreshGitLabAuthorization(config, {
      refreshToken: "synthetic-refresh-current",
    }).catch((error: unknown) => error);
    expect(rejected).toHaveProperty(
      "oauthRefreshOutcome",
      expect.objectContaining({
        outcome: "rejected",
        reason: "invalid_grant",
      }),
    );
    const uncertain = await refreshGitLabAuthorization(config, {
      refreshToken: "synthetic-refresh-current",
    }).catch((error: unknown) => error);
    expect(uncertain).toHaveProperty(
      "oauthRefreshOutcome",
      expect.objectContaining({
        phase: "after-token-response",
        outcome: "unknown",
      }),
    );
    expect(isRecoverableOAuthRefreshFailure(uncertain)).toBe(false);
  });

  it("refreshes with the public client and records scopes from token info", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(token({ scope: "api" })))
      .mockResolvedValueOnce(respond(info("write_repository api")));
    const refreshed = await refreshGitLabAuthorization(config, {
      refreshToken: "synthetic-refresh-current",
    });
    expect(refreshed.scopes).toEqual(["api", "write_repository"]);
    const request = fetchMock.mock.calls[0]![1]!;
    expect((request.body as URLSearchParams).toString()).toContain("grant_type=refresh_token");
    expect((request.body as URLSearchParams).toString()).toContain("client_id=public-client");
    expect((request.body as URLSearchParams).toString()).not.toContain("client_secret");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://gitlab.example.test/oauth/token/info");
  });

  it("bounds provider data and sanitizes transport diagnostics", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("x".repeat(17_000)));
    const authorization = createGitLabAuthorization(config);
    await expect(
      exchangeGitLabAuthorization(config, { code: "code", verifier: authorization.verifier }),
    ).rejects.toThrow("GitLab authorization failed; start a new sign-in.");
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("secret transport details"));
    const failure = await refreshGitLabAuthorization(config, {
      refreshToken: "synthetic-refresh-current",
    }).catch((error: unknown) => error);
    expect(failure).toHaveProperty("message", "GitLab OAuth token refresh failed");
    expect(failure).toHaveProperty(
      "oauthRefreshOutcome",
      expect.objectContaining({ outcome: "unknown" }),
    );
  });

  it("permits a later attempt only when authority failed before refresh dispatch", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const failure = await refreshGitLabAuthorization(config, {
      refreshToken: "synthetic-refresh-current",
      assertCurrent: () => {
        throw new Error("retired");
      },
    }).catch((error: unknown) => error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isRecoverableOAuthRefreshFailure(failure)).toBe(true);
  });
});
