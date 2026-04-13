import { describe, expect, it, vi } from "vitest";
import type { M365ResolvedAccountConfig, M365ResolvedPluginConfig } from "./config.js";
import type { M365CredentialStore, M365DelegatedCredentials } from "./credentials.js";
import { M365GraphClient, resolveM365GraphAccessToken, type M365Fetch } from "./graph-client.js";

function baseConfig(): M365ResolvedPluginConfig {
  return {
    enabled: true,
    defaultAccountId: "default",
    graphBaseUrl: "https://graph.test/v1.0",
    tokenBaseUrl: "https://login.test",
    accounts: {},
    triage: { limit: 10, sinceMinutes: 60, unreadOnly: true },
    allowedMailboxes: ["assistant@example.com"],
    allowedCalendars: [],
    approval: { timeoutMs: 300000, previewChars: 1000, teamsUserIds: [] },
    webhook: {
      enabled: false,
      path: "/plugins/m365/notifications",
      expirationMinutes: 60,
      maxBodyBytes: 10000,
    },
  };
}

function account(overrides: Partial<M365ResolvedAccountConfig> = {}): M365ResolvedAccountConfig {
  return {
    accountId: "default",
    enabled: true,
    authMode: "app-only",
    identityId: "default",
    tenantId: "tenant",
    clientId: "client",
    clientSecret: "secret",
    mailboxUserId: "assistant@example.com",
    folder: "inbox",
    maxBodyChars: 12000,
    allowedReplyDomains: [],
    ...overrides,
  };
}

function memoryCredentialStore(initial: M365DelegatedCredentials | null): M365CredentialStore {
  let value = initial;
  return {
    pathForIdentity: (identityId) => `/tmp/${identityId}.json`,
    load: vi.fn(async () => value),
    save: vi.fn(async (credentials) => {
      value = credentials;
    }),
    delete: vi.fn(async () => {
      value = null;
    }),
  };
}

describe("m365 graph auth and client", () => {
  it("requests app-only tokens with client credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 }),
    );
    const fetchImpl = fetchMock as M365Fetch;

    const token = await resolveM365GraphAccessToken({
      account: account(),
      config: baseConfig(),
      fetchImpl,
      nowMs: 1000,
    });

    expect(token).toMatchObject({ accessToken: "token", source: "app-only" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://login.test/tenant/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" }),
    );
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const requestInit = fetchCalls[0]?.[1];
    const body = requestInit?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("uses delegated cached tokens until they are near expiry", async () => {
    const store = memoryCredentialStore({
      version: 1,
      identityId: "delegate",
      tenantId: "tenant",
      clientId: "client",
      tokenType: "Bearer",
      accessToken: "cached-token",
      refreshToken: "refresh-token",
      expiresAt: 10_000_000,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchImpl = vi.fn() as unknown as M365Fetch;

    const token = await resolveM365GraphAccessToken({
      account: account({ authMode: "delegated", identityId: "delegate" }),
      config: baseConfig(),
      credentialStore: store,
      fetchImpl,
      nowMs: 1000,
    });

    expect(token).toMatchObject({ accessToken: "cached-token", source: "delegated-cache" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes delegated tokens and persists the update", async () => {
    const store = memoryCredentialStore({
      version: 1,
      identityId: "delegate",
      tenantId: "tenant",
      clientId: "client",
      tokenType: "Bearer",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      expiresAt: 1000,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: "fresh-refresh",
            expires_in: 3600,
            scope: "Mail.Read Mail.Send",
          }),
          { status: 200 },
        ),
    ) as M365Fetch;

    const token = await resolveM365GraphAccessToken({
      account: account({ authMode: "delegated", identityId: "delegate" }),
      config: baseConfig(),
      credentialStore: store,
      fetchImpl,
      nowMs: 2000,
    });

    expect(token).toMatchObject({ accessToken: "fresh-token", source: "delegated-refresh" });
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "fresh-token" }),
    );
  });

  it("adds bearer auth to Graph requests", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new M365GraphClient({
      account: account(),
      config: baseConfig(),
      fetchImpl,
      nowMs: () => 1000,
    });

    await expect(client.requestJson("/me")).resolves.toEqual({ ok: true });

    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer token",
    });
  });
});
