import { Buffer } from "node:buffer";
import type { OpenClawPluginAuthContext } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { createMSTeamsSsoTokenStoreMemory } from "../sso-token-store.js";
import type { MSTeamsSsoFetch } from "../sso.js";
import "./message-handler-mock-support.test-support.js";
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

function createJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("msteams message handler delegated auth", () => {
  it("passes a runtime auth resolver to reply dispatch without adding tokens to ctxPayload", async () => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
    const token = createJwt({
      aud: "api://downstream-tools",
      scp: "downstream.access",
    });
    const fetchImpl: MSTeamsSsoFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          connectionName: "ToolsConnection",
          token,
          expiration: "2035-01-01T00:00:00Z",
        };
      },
      async text() {
        return "";
      },
    }));
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "open",
          allowFrom: ["*"],
          sso: { enabled: true, connectionName: "ToolsConnection" },
        },
      },
    } as OpenClawConfig;
    const { deps } = createMessageHandlerDeps(cfg);
    deps.sso = {
      tokenProvider: deps.tokenProvider,
      tokenStore: createMSTeamsSsoTokenStoreMemory(),
      connectionName: "ToolsConnection",
      fetchImpl,
    };

    await createMSTeamsMessageHandler(deps)({
      activity: {
        id: "msg-1",
        type: "message",
        text: "hello",
        channelId: "msteams",
        from: { id: "bf-user", aadObjectId: "aad-user", name: "Test User" },
        recipient: { id: "bot-id", name: "OpenClaw" },
        conversation: { id: "conv-1", conversationType: "personal", tenantId: "tenant-1" },
        attachments: [],
        entities: [],
      },
      sendActivity: vi.fn(async () => undefined),
      sendActivities: vi.fn(async () => []),
      updateActivity: vi.fn(async () => undefined),
      deleteActivity: vi.fn(async () => undefined),
    });
    const dispatchParams = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock
      .calls[0]?.[0] as
      | {
          ctxPayload?: unknown;
          replyOptions?: { pluginAuth?: OpenClawPluginAuthContext };
        }
      | undefined;
    const auth = dispatchParams?.replyOptions?.pluginAuth;
    expect(auth).toBeDefined();
    expect(JSON.stringify(dispatchParams?.ctxPayload)).not.toContain(token);

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://downstream-tools",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: true,
      token,
      expiresAt: "2035-01-01T00:00:00Z",
      tenantId: "tenant-1",
      userId: "aad-user",
    });
  });

  it("wires missing-consent OAuth card delivery through the active Teams turn", async () => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
    const fetchImpl: MSTeamsSsoFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
        async text() {
          return "not found";
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
        async text() {
          return "not found";
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        async json() {
          return {
            signInLink: "https://signin.example.test/start",
            tokenExchangeResource: {
              id: "exchange-1",
              uri: "api://downstream-tools",
              providerId: "provider-1",
            },
          };
        },
        async text() {
          return "";
        },
      });
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "open",
          allowFrom: ["*"],
          sso: { enabled: true, connectionName: "ToolsConnection" },
        },
      },
    } as OpenClawConfig;
    const { deps } = createMessageHandlerDeps(cfg);
    deps.sso = {
      tokenProvider: deps.tokenProvider,
      tokenStore: createMSTeamsSsoTokenStoreMemory(),
      connectionName: "ToolsConnection",
      fetchImpl,
    };
    deps.recordSsoSignInChallenge = vi.fn();
    const sendActivity = vi.fn(async () => undefined);
    const activity: MSTeamsTurnContext["activity"] = {
      id: "msg-1",
      type: "message",
      text: "hello",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: { id: "bf-user", aadObjectId: "aad-user", name: "Test User" },
      recipient: { id: "bot-id", name: "OpenClaw" },
      conversation: { id: "conv-1", conversationType: "personal", tenantId: "tenant-1" },
      attachments: [],
      entities: [],
    };

    await createMSTeamsMessageHandler(deps)({
      activity,
      sendActivity,
      sendActivities: vi.fn(async () => []),
      updateActivity: vi.fn(async () => undefined),
      deleteActivity: vi.fn(async () => undefined),
    });

    const dispatchParams = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock
      .calls[0]?.[0] as
      | {
          replyOptions?: { pluginAuth?: OpenClawPluginAuthContext };
        }
      | undefined;
    const auth = dispatchParams?.replyOptions?.pluginAuth;

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://downstream-tools",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });

    expect(sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("https://signin.example.test/start"),
        attachments: [
          expect.objectContaining({
            contentType: "application/vnd.microsoft.card.oauth",
          }),
        ],
      }),
    );
    expect(deps.recordSsoSignInChallenge).toHaveBeenCalledWith(activity);
  });

  it("logs missing-consent OAuth card delivery failures", async () => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
    const fetchImpl: MSTeamsSsoFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
        async text() {
          return "not found";
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        async json() {
          return {};
        },
        async text() {
          return "not found";
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        async json() {
          return {
            signInLink: "https://signin.example.test/start",
          };
        },
        async text() {
          return "";
        },
      });
    const cfg = {
      channels: {
        msteams: {
          dmPolicy: "open",
          allowFrom: ["*"],
          sso: { enabled: true, connectionName: "ToolsConnection" },
        },
      },
    } as OpenClawConfig;
    const { deps } = createMessageHandlerDeps(cfg);
    deps.sso = {
      tokenProvider: deps.tokenProvider,
      tokenStore: createMSTeamsSsoTokenStoreMemory(),
      connectionName: "ToolsConnection",
      fetchImpl,
    };
    const sendActivity = vi.fn(async () => {
      throw new Error("OAuth card send failed");
    });

    await createMSTeamsMessageHandler(deps)({
      activity: {
        id: "msg-1",
        type: "message",
        text: "hello",
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
        from: { id: "bf-user", aadObjectId: "aad-user", name: "Test User" },
        recipient: { id: "bot-id", name: "OpenClaw" },
        conversation: { id: "conv-1", conversationType: "personal", tenantId: "tenant-1" },
        attachments: [],
        entities: [],
      },
      sendActivity,
      sendActivities: vi.fn(async () => []),
      updateActivity: vi.fn(async () => undefined),
      deleteActivity: vi.fn(async () => undefined),
    });

    const dispatchParams = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock
      .calls[0]?.[0] as
      | {
          replyOptions?: { pluginAuth?: OpenClawPluginAuthContext };
        }
      | undefined;
    const auth = dispatchParams?.replyOptions?.pluginAuth;

    await expect(
      auth?.getDelegatedAccessToken({
        provider: "msteams",
        audience: "api://downstream-tools",
        scopes: ["downstream.access"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "missing_consent",
    });

    expect(deps.log.warn).toHaveBeenCalledWith(
      "msteams delegated auth consent challenge failed: OAuth card send failed",
    );
  });
});
