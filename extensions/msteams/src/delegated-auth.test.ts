import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { createMSTeamsDelegatedAuthContext } from "./delegated-auth.js";
import { createMSTeamsSsoTokenStoreMemory } from "./sso-token-store.js";
import type { MSTeamsSsoDeps, MSTeamsSsoFetch } from "./sso.js";

type FakeFetchCall = {
  url: string;
  init?: Parameters<MSTeamsSsoFetch>[1];
};

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function createSsoDeps(responses: Array<{ status: number; body: unknown }>) {
  const calls: FakeFetchCall[] = [];
  const fetchImpl: MSTeamsSsoFetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift() ?? { status: 404, body: "not found" };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() {
        return response.body;
      },
      async text() {
        return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      },
    };
  };
  const deps: MSTeamsSsoDeps = {
    tokenProvider: {
      getAccessToken: vi.fn(async () => "bot-framework-token"),
    },
    tokenStore: createMSTeamsSsoTokenStoreMemory(),
    connectionName: "ToolsConnection",
    fetchImpl,
  };
  return { deps, calls };
}

describe("msteams delegated auth context", () => {
  it("returns not_configured without SSO deps", async () => {
    const auth = createMSTeamsDelegatedAuthContext({
      activity: {
        type: "message",
        channelId: "msteams",
        from: { id: "bf-user", aadObjectId: "aad-user" },
      },
    });

    await expect(auth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
  });

  it("resolves a delegated token on demand and caches it for the run", async () => {
    const token = createJwt({
      aud: "api://downstream-tools",
      scp: "downstream.access other.scope",
    });
    const { deps, calls } = createSsoDeps([
      { status: 404, body: "not found for aad id" },
      {
        status: 200,
        body: {
          connectionName: "ToolsConnection",
          token,
          expiration: "2035-01-01T00:00:00Z",
        },
      },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: {
        type: "message",
        channelId: "msteams",
        conversation: { id: "conv", tenantId: "tenant-1" },
        from: { id: "bf-user", aadObjectId: "aad-user" },
      },
      now: () => new Date("2030-01-01T00:00:00Z"),
    });

    const first = await auth.getDelegatedAccessToken({
      provider: "msteams",
      audience: "api://downstream-tools",
      scopes: ["downstream.access"],
    });
    const second = await auth.getDelegatedAccessToken({
      provider: "msteams",
      audience: "api://downstream-tools",
      scopes: ["downstream.access"],
    });

    expect(first).toEqual({
      ok: true,
      token,
      expiresAt: "2035-01-01T00:00:00Z",
      tenantId: "tenant-1",
      userId: "aad-user",
    });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("userId=aad-user");
    expect(calls[1]?.url).toContain("userId=bf-user");
  });

  it("accepts Entra app-id audience claims for api scheme app-id audiences", async () => {
    const token = createJwt({
      aud: "b37997f3-9806-4b6b-86ac-d2c9ff8c1eea",
      scp: "downstream.access",
    });
    const { deps } = createSsoDeps([
      {
        status: 200,
        body: {
          connectionName: "ToolsConnection",
          token,
          expiration: "2035-01-01T00:00:00Z",
        },
      },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: {
        type: "message",
        channelId: "msteams",
        conversation: { id: "conv", tenantId: "tenant-1" },
        from: { id: "bf-user" },
      },
      now: () => new Date("2030-01-01T00:00:00Z"),
    });

    await expect(
      auth.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://b37997f3-9806-4b6b-86ac-d2c9ff8c1eea",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: true,
      token,
      expiresAt: "2035-01-01T00:00:00Z",
      tenantId: "tenant-1",
      userId: "bf-user",
    });
  });

  it("rejects plugin-supplied connection names that differ from configured Teams SSO", async () => {
    const { deps, calls } = createSsoDeps([
      {
        status: 200,
        body: {
          connectionName: "OtherConnection",
          token: createJwt({ aud: "api://other", scp: "other.access" }),
          expiration: "2035-01-01T00:00:00Z",
        },
      },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: { type: "message", channelId: "msteams", from: { id: "bf-user" } },
    });

    await expect(
      auth.getDelegatedAccessToken({
        provider: "msteams",
        connectionName: "OtherConnection",
        audience: "api://other",
        scopes: ["other.access"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "not_configured",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns missing_consent when Bot Framework has no token for the user", async () => {
    const { deps } = createSsoDeps([
      { status: 404, body: "not found" },
      { status: 412, body: "consent required" },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: {
        type: "message",
        channelId: "msteams",
        from: { id: "bf-user", aadObjectId: "aad-user" },
      },
    });

    await expect(auth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });
  });

  it("sends an OAuth card when consent is missing", async () => {
    const { deps, calls } = createSsoDeps([
      { status: 404, body: "not found for aad id" },
      { status: 404, body: "not found for bot framework id" },
      {
        status: 200,
        body: {
          signInLink: "https://signin.example.test/start",
          tokenExchangeResource: {
            id: "exchange-1",
            uri: "api://downstream-tools",
            providerId: "provider-1",
          },
        },
      },
    ]);
    const sendActivity = vi.fn(async () => ({ id: "oauth-card" }));
    const onDebug = vi.fn();
    const onConsentChallengeSent = vi.fn();
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      botAppId: "bot-app-id",
      sendActivity,
      onDebug,
      onConsentChallengeSent,
      activity: {
        id: "msg-1",
        type: "message",
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
        from: { id: "bf-user", aadObjectId: "aad-user" },
        recipient: { id: "bot-id", name: "OpenClaw" },
        conversation: { id: "conv", conversationType: "personal", tenantId: "tenant-1" },
      },
    });

    await expect(
      auth.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://downstream-tools",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });

    expect(calls).toHaveLength(3);
    const signInResourceCall = calls[2];
    expect(signInResourceCall).toBeDefined();
    if (!signInResourceCall) {
      throw new Error("missing sign-in resource call");
    }
    expect(signInResourceCall.url).toContain("/api/botsignin/GetSignInResource");
    expect(signInResourceCall.url).toMatch(/^https:\/\/token\.botframework\.com\//);
    const signInState = new URL(signInResourceCall.url).searchParams.get("state");
    expect(signInState).toBeTruthy();
    if (!signInState) {
      throw new Error("missing sign-in state");
    }
    expect(JSON.parse(Buffer.from(signInState, "base64").toString("utf8"))).toEqual({
      connectionName: "ToolsConnection",
      conversation: {
        activityId: "msg-1",
        user: { id: "bf-user", aadObjectId: "aad-user" },
        bot: { id: "bot-id", name: "OpenClaw" },
        conversation: { id: "conv", conversationType: "personal", tenantId: "tenant-1" },
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
      },
      msAppId: "bot-app-id",
    });
    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "message",
        text: expect.stringContaining("https://signin.example.test/start"),
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.card.oauth",
            content: expect.objectContaining({
              text: "Sign in to allow OpenClaw to use your Microsoft Teams delegated access for this tool.",
              connectionName: "ToolsConnection",
              tokenExchangeResource: {
                id: "exchange-1",
                uri: "api://downstream-tools",
                providerId: "provider-1",
              },
            }),
          }),
        ],
      }),
    );
    expect(onDebug).not.toHaveBeenCalled();
    expect(onConsentChallengeSent).toHaveBeenCalledOnce();
  });

  it("does not send duplicate OAuth cards for repeated missing-consent checks in one run", async () => {
    const { deps } = createSsoDeps([
      { status: 404, body: "not found for aad id" },
      { status: 404, body: "not found for bot framework id" },
      {
        status: 200,
        body: {
          signInLink: "https://signin.example.test/start",
          tokenExchangeResource: { uri: "api://downstream-tools" },
        },
      },
      { status: 404, body: "not found for aad id" },
      { status: 404, body: "not found for bot framework id" },
    ]);
    const sendActivity = vi.fn(async () => ({ id: "oauth-card" }));
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      botAppId: "bot-app-id",
      sendActivity,
      activity: {
        id: "msg-1",
        type: "message",
        channelId: "msteams",
        from: { id: "bf-user", aadObjectId: "aad-user" },
      },
    });

    const request = {
      provider: "msteams",
      audience: "api://downstream-tools",
      scopes: ["downstream.access"],
    };
    await expect(auth.getDelegatedAccessToken(request)).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });
    await expect(auth.getDelegatedAccessToken(request)).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });

    expect(sendActivity).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable when Bot Framework service token acquisition fails", async () => {
    const { deps, calls } = createSsoDeps([]);
    deps.tokenProvider.getAccessToken = vi.fn(async () => {
      throw new Error("token provider unavailable");
    });
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: { type: "message", channelId: "msteams", from: { id: "bf-user" } },
    });

    await expect(auth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("returns unavailable when the Bot Framework User Token service request fails", async () => {
    const calls: FakeFetchCall[] = [];
    const { deps } = createSsoDeps([]);
    deps.fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      throw new Error("network unavailable");
    });
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: { type: "message", channelId: "msteams", from: { id: "bf-user" } },
    });

    await expect(auth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects expired tokens explicitly", async () => {
    const { deps } = createSsoDeps([
      {
        status: 200,
        body: {
          connectionName: "ToolsConnection",
          token: createJwt({ aud: "api://downstream-tools", scp: "downstream.access" }),
          expiration: "2030-01-01T00:00:10Z",
        },
      },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: { type: "message", channelId: "msteams", from: { id: "bf-user" } },
      now: () => new Date("2030-01-01T00:00:00Z"),
    });

    await expect(auth.getDelegatedAccessToken({ provider: "msteams" })).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects tokens that do not match the requested audience and scope", async () => {
    const { deps } = createSsoDeps([
      {
        status: 200,
        body: {
          connectionName: "ToolsConnection",
          token: createJwt({ aud: "api://other-api", scp: "other.scope" }),
          expiration: "2035-01-01T00:00:00Z",
        },
      },
    ]);
    const auth = createMSTeamsDelegatedAuthContext({
      sso: deps,
      activity: { type: "message", channelId: "msteams", from: { id: "bf-user" } },
      now: () => new Date("2030-01-01T00:00:00Z"),
    });

    await expect(
      auth.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://downstream-tools",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });
});
