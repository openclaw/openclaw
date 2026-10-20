import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const hostMockState = vi.hoisted(() => ({
  tokenError: null as Error | null,
  delegatedTokenAccountId: undefined as string | null | undefined,
  delegatedTokens: undefined as ReturnType<typeof delegatedTokens> | undefined,
}));

vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    tokenProvider = {
      getAppToken: async () => {
        if (hostMockState.tokenError) {
          throw hostMockState.tokenError;
        }
        return { toString: () => "token" };
      },
    };
  },
  ExpressAdapter: vi.fn(),
}));

vi.mock("@microsoft/teams.api", () => ({
  Client: function Client() {},
  cloudFromName: () => ({
    botScope: "https://api.botframework.com/.default",
    graphScope: "https://graph.microsoft.com/.default",
  }),
}));

vi.mock("./delegated-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./delegated-state.js")>();
  return {
    ...actual,
    loadMSTeamsDelegatedTokens: async (accountId?: string | null) => {
      hostMockState.delegatedTokenAccountId = accountId;
      return hostMockState.delegatedTokens;
    },
  };
});

import { probeMSTeams } from "./probe.js";

const config = (overrides: Partial<MSTeamsConfig> = {}): MSTeamsConfig => ({
  enabled: true,
  appId: "app",
  appPassword: "pw",
  tenantId: "tenant",
  ...overrides,
});
const delegatedTokens = () => ({
  accessToken: "delegated-token",
  refreshToken: "refresh-token",
  expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
  scopes: ["ChatMessage.Send"],
  userPrincipalName: "user@example.com",
});

describe("msteams probe", () => {
  beforeEach(() => {
    hostMockState.tokenError = null;
    hostMockState.delegatedTokenAccountId = undefined;
    hostMockState.delegatedTokens = undefined;
    vi.stubEnv("MSTEAMS_APP_ID", "");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns an error when credentials are missing", async () => {
    await expect(probeMSTeams({ enabled: true })).resolves.toEqual({
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)",
    });
  });

  it("does not use default env credentials when probing a named account", async () => {
    vi.stubEnv("MSTEAMS_APP_ID", "default-env-app");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "default-env-password");
    vi.stubEnv("MSTEAMS_TENANT_ID", "default-env-tenant");
    const cfg = { enabled: true, tenantId: "tenant" } satisfies MSTeamsConfig;

    await expect(probeMSTeams(cfg, { accountId: "support" })).resolves.toEqual({
      ok: false,
      error: "missing credentials (appId, appPassword, tenantId)",
    });
  });

  it("validates credentials by acquiring a token", async () => {
    await expect(probeMSTeams(config())).resolves.toEqual({
      ok: true,
      appId: "app",
      graph: { ok: true, roles: undefined, scopes: undefined },
    });
  });

  it("returns a helpful error when token acquisition fails", async () => {
    hostMockState.tokenError = new Error("bad creds");
    await expect(probeMSTeams(config())).resolves.toEqual({
      ok: false,
      appId: "app",
      error: "bad creds",
    });
  });

  it("reports delegated tokens expired when the process clock is invalid", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    hostMockState.delegatedTokens = delegatedTokens();

    try {
      await expect(probeMSTeams(config({ delegatedAuth: { enabled: true } }))).resolves.toEqual({
        ok: true,
        appId: "app",
        graph: { ok: true, roles: undefined, scopes: undefined },
        delegatedAuth: {
          ok: false,
          scopes: ["ChatMessage.Send"],
          userPrincipalName: "user@example.com",
          error: "token expired (will auto-refresh on next use)",
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("loads delegated tokens for the selected account", async () => {
    hostMockState.delegatedTokens = delegatedTokens();

    await expect(
      probeMSTeams(config({ delegatedAuth: { enabled: true } }), { accountId: "support" }),
    ).resolves.toMatchObject({
      ok: true,
      delegatedAuth: {
        ok: true,
        scopes: ["ChatMessage.Send"],
        userPrincipalName: "user@example.com",
      },
    });
    expect(hostMockState.delegatedTokenAccountId).toBe("support");
  });
});
