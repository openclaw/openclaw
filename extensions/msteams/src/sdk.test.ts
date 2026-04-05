import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBotFrameworkJwtValidator,
  createMSTeamsAdapter,
  createMSTeamsApp,
  type MSTeamsTeamsSdk,
} from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

const jwtValidatorState = vi.hoisted(() => ({
  instances: [] as Array<{ config: Record<string, unknown> }>,
  behaviorByJwks: new Map<string, "success" | "null" | "throw">(),
  calls: [] as Array<{ jwksUri: string; token: string; overrideOptions?: unknown }>,
}));

const clientConstructorState = vi.hoisted(() => ({
  calls: [] as Array<{ serviceUrl: string; options: unknown }>,
}));

vi.mock("@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js", () => ({
  JwtValidator: class JwtValidator {
    private readonly config: Record<string, unknown>;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      jwtValidatorState.instances.push({ config });
    }

    async validateAccessToken(token: string, overrideOptions?: unknown): Promise<object | null> {
      const jwksUri = String((this.config.jwksUriOptions as { uri?: string })?.uri ?? "");
      jwtValidatorState.calls.push({ jwksUri, token, overrideOptions });
      const behavior = jwtValidatorState.behaviorByJwks.get(jwksUri) ?? "null";
      if (behavior === "throw") {
        throw new Error("validator error");
      }
      return behavior === "success" ? { sub: "ok" } : null;
    }
  },
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clientConstructorState.calls.length = 0;
  jwtValidatorState.instances.length = 0;
  jwtValidatorState.calls.length = 0;
  jwtValidatorState.behaviorByJwks.clear();
  vi.restoreAllMocks();
});

function createSdkStub(): MSTeamsTeamsSdk {
  class AppStub {
    async getBotToken() {
      return {
        toString() {
          return "bot-token";
        },
      };
    }
  }

  class ClientStub {
    constructor(serviceUrl: string, options: unknown) {
      clientConstructorState.calls.push({ serviceUrl, options });
    }

    conversations = {
      activities: (_conversationId: string) => ({
        create: async (_activity: unknown) => ({ id: "created" }),
      }),
    };
  }

  return {
    App: AppStub as unknown as MSTeamsTeamsSdk["App"],
    Client: ClientStub as unknown as MSTeamsTeamsSdk["Client"],
  };
}

describe("createMSTeamsApp", () => {
  it("does not crash with express 5 path-to-regexp (#55161)", async () => {
    // Regression test for: https://github.com/openclaw/openclaw/issues/55161
    // createMSTeamsApp passes a no-op httpServerAdapter to prevent the SDK from
    // creating its default HttpPlugin (which registers `/api*` — invalid in Express 5).
    const { App } = await import("@microsoft/teams.apps");
    const { Client } = await import("@microsoft/teams.api");
    const sdk: MSTeamsTeamsSdk = { App, Client };
    const creds: MSTeamsCredentials = {
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    // This would throw "Missing parameter name at index 5: /api*" without the fix
    const app = await createMSTeamsApp(creds, sdk);
    expect(app).toBeDefined();
    // Verify token methods are available (the reason we use the App class)
    expect(typeof (app as unknown as Record<string, unknown>).getBotToken).toBe("function");
  });
});

describe("createMSTeamsAdapter", () => {
  it("provides deleteActivity in proactive continueConversation contexts", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const creds = {
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    } satisfies MSTeamsCredentials;
    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: creds.appId,
      clientSecret: creds.appPassword,
      tenantId: creds.tenantId,
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      creds.appId,
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conversation@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.deleteActivity("activity-123");
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://service.example.com/v3/conversations/19%3Aconversation%40thread.tacv2/activities/activity-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer bot-token",
        }),
      }),
    );
  });

  it("passes the OpenClaw User-Agent to the Bot Framework connector client", async () => {
    const creds = {
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
    } satisfies MSTeamsCredentials;
    const sdk = createSdkStub();
    const app = new sdk.App({
      clientId: creds.appId,
      clientSecret: creds.appPassword,
      tenantId: creds.tenantId,
    });
    const adapter = createMSTeamsAdapter(app, sdk);

    await adapter.continueConversation(
      creds.appId,
      {
        serviceUrl: "https://service.example.com/",
        conversation: { id: "19:conversation@thread.tacv2" },
        channelId: "msteams",
      },
      async (ctx) => {
        await ctx.sendActivity("hello");
      },
    );

    expect(clientConstructorState.calls).toHaveLength(1);
    expect(clientConstructorState.calls[0]).toMatchObject({
      serviceUrl: "https://service.example.com/",
      options: {
        headers: {
          "User-Agent": expect.stringMatching(/^teams\.ts\[apps\]\/.+ OpenClaw\/.+$/),
        },
      },
    });
  });
});

describe("createBotFrameworkJwtValidator", () => {
  const creds = {
    appId: "app-id",
    appPassword: "secret",
    tenantId: "tenant-id",
  } satisfies MSTeamsCredentials;

  it("validates with legacy Bot Framework JWKS and issuer first", async () => {
    jwtValidatorState.behaviorByJwks.set(
      "https://login.botframework.com/v1/.well-known/keys",
      "success",
    );

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-1", "https://service.example.com")).resolves.toBe(
      true,
    );

    expect(jwtValidatorState.instances).toHaveLength(2);
    expect(jwtValidatorState.calls).toHaveLength(1);
    expect(jwtValidatorState.calls[0]).toMatchObject({
      jwksUri: "https://login.botframework.com/v1/.well-known/keys",
      token: "token-1",
      overrideOptions: {
        validateServiceUrl: { expectedServiceUrl: "https://service.example.com" },
      },
    });
  });

  it("falls back to Entra JWKS when Bot Framework validation fails", async () => {
    jwtValidatorState.behaviorByJwks.set(
      "https://login.botframework.com/v1/.well-known/keys",
      "null",
    );
    jwtValidatorState.behaviorByJwks.set(
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      "success",
    );

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-2")).resolves.toBe(true);

    expect(jwtValidatorState.calls).toHaveLength(2);
    expect(jwtValidatorState.calls[0]?.jwksUri).toBe(
      "https://login.botframework.com/v1/.well-known/keys",
    );
    expect(jwtValidatorState.calls[1]?.jwksUri).toBe(
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
    );

    const entraConfig = jwtValidatorState.instances
      .map((instance) => instance.config)
      .find(
        (config) =>
          String((config.jwksUriOptions as { uri?: string })?.uri) ===
          "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      );
    expect(entraConfig).toBeDefined();
    expect(entraConfig?.validateIssuer).toEqual({ allowedTenantIds: ["tenant-id"] });
  });

  it("falls back to Entra JWKS when Bot Framework validation throws", async () => {
    jwtValidatorState.behaviorByJwks.set(
      "https://login.botframework.com/v1/.well-known/keys",
      "throw",
    );
    jwtValidatorState.behaviorByJwks.set(
      "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      "success",
    );

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(
      validator.validate("Bearer token-throw", "https://service.example.com"),
    ).resolves.toBe(true);

    expect(jwtValidatorState.calls).toHaveLength(2);
    expect(jwtValidatorState.calls[0]).toMatchObject({
      jwksUri: "https://login.botframework.com/v1/.well-known/keys",
      token: "token-throw",
      overrideOptions: {
        validateServiceUrl: { expectedServiceUrl: "https://service.example.com" },
      },
    });
    expect(jwtValidatorState.calls[1]).toMatchObject({
      jwksUri: "https://login.microsoftonline.com/common/discovery/v2.0/keys",
      token: "token-throw",
      overrideOptions: {
        validateServiceUrl: { expectedServiceUrl: "https://service.example.com" },
      },
    });
  });

  it("returns false when all validator paths fail", async () => {
    jwtValidatorState.behaviorByJwks.set(
      "https://login.botframework.com/v1/.well-known/keys",
      "throw",
    );

    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer token-3")).resolves.toBe(false);
    expect(jwtValidatorState.calls).toHaveLength(2);
  });

  it("returns false for empty bearer token", async () => {
    const validator = await createBotFrameworkJwtValidator(creds);
    await expect(validator.validate("Bearer ")).resolves.toBe(false);
    expect(jwtValidatorState.calls).toHaveLength(0);
  });
});
