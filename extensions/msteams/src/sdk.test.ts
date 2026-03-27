import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsAdapter, createMSTeamsApp, type MSTeamsTeamsSdk } from "./sdk.js";
import type { MSTeamsCredentials } from "./token.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
    constructor(_serviceUrl: string, _options: unknown) {}

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
    // The default HttpPlugin in @microsoft/teams.apps uses `express().use('/api*', ...)`
    // which throws in express 5 (path-to-regexp v8+). createMSTeamsApp injects a no-op
    // HTTP plugin stub to prevent the SDK from creating the default HttpPlugin.
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
});
