import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import "./monitor-handler/message-handler-mock-support.test-support.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import {
  createActivityHandler as baseCreateActivityHandler,
  createMSTeamsMessageHandlerDeps,
  installMSTeamsTestRuntime,
} from "./monitor-handler.test-helpers.js";
import { getRuntimeApiMockState } from "./monitor-handler/message-handler-mock-support.test-support.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { createMSTeamsSsoTokenStoreMemory } from "./sso-token-store.js";
import {
  type MSTeamsSsoFetch,
  getMSTeamsSsoUserToken,
  handleSigninTokenExchangeInvoke,
  handleSigninVerifyStateInvoke,
  parseSigninTokenExchangeValue,
  parseSigninVerifyStateValue,
} from "./sso.js";

const runtimeApiMockState = getRuntimeApiMockState();

function createActivityHandler() {
  const run = vi.fn(async () => undefined);
  const handler = baseCreateActivityHandler(run);
  return { handler, run };
}

function createDispatchingActivityHandler() {
  type Handler = Parameters<MSTeamsActivityHandler["onMessage"]>[0];
  const messageHandlers: Handler[] = [];
  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  const run = vi.fn(async (context: unknown) => {
    const ctx = context as { activity?: { type?: string } };
    if (ctx.activity?.type !== "message") {
      return;
    }
    for (const messageHandler of messageHandlers) {
      await messageHandler(context, async () => {});
    }
  });
  handler = {
    onMessage: (messageHandler) => {
      messageHandlers.push(messageHandler);
      return handler;
    },
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };
  return { handler, run };
}

function createDepsWithoutSso(
  overrides: Partial<MSTeamsMessageHandlerDeps> = {},
): MSTeamsMessageHandlerDeps {
  const base = createMSTeamsMessageHandlerDeps();
  return { ...base, ...overrides };
}

function createSsoDeps(params: { fetchImpl: MSTeamsSsoFetch }) {
  const tokenStore = createMSTeamsSsoTokenStoreMemory();
  const tokenProvider = {
    getAccessToken: vi.fn(async () => "bf-service-token"),
  };
  return {
    sso: {
      tokenProvider,
      tokenStore,
      connectionName: "GraphConnection",
      fetchImpl: params.fetchImpl,
    },
    tokenStore,
    tokenProvider,
  };
}

function createRegisteredSsoHandler(sso: MSTeamsMessageHandlerDeps["sso"]) {
  const deps = createDepsWithoutSso({ sso });
  const { handler } = createActivityHandler();
  const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  return { deps, registered };
}

function createSigninInvokeContext(params: {
  name: "signin/tokenExchange" | "signin/verifyState" | "signin/failure";
  value: unknown;
  userAadId?: string;
  userBfId?: string;
  conversationId?: string;
  conversationType?: "personal" | "groupChat" | "channel";
  teamId?: string;
  channelName?: string;
}): MSTeamsTurnContext & { sendActivity: ReturnType<typeof vi.fn> } {
  const conversationType = params.conversationType ?? "personal";
  const conversationId =
    params.conversationId ??
    (conversationType === "personal"
      ? "19:personal-chat"
      : conversationType === "channel"
        ? "19:channel@thread.tacv2"
        : "19:group@thread.tacv2");

  return {
    activity: {
      id: "invoke-1",
      type: "invoke",
      name: params.name,
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: params.userBfId ?? "bf-user",
        aadObjectId: params.userAadId ?? "aad-user-guid",
        name: "Test User",
      },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: conversationId,
        conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      attachments: [],
      value: params.value,
    },
    sendActivity: vi.fn(async () => ({ id: "ack-id" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "update" })),
    deleteActivity: vi.fn(async () => {}),
  } as unknown as MSTeamsTurnContext & {
    sendActivity: ReturnType<typeof vi.fn>;
  };
}

function createSigninCodeMessageContext(params: {
  text: string;
  userAadId?: string;
  userBfId?: string;
}): MSTeamsTurnContext & { sendActivity: ReturnType<typeof vi.fn> } {
  return {
    activity: {
      id: "message-1",
      type: "message",
      text: params.text,
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: params.userBfId ?? "bf-user",
        aadObjectId: params.userAadId ?? "aad-user-guid",
        name: "Test User",
      },
      recipient: { id: "bot-id", name: "Bot" },
      conversation: {
        id: "19:personal-chat",
        conversationType: "personal",
      },
      attachments: [],
      entities: [],
    },
    sendActivity: vi.fn(async () => ({ id: "message-id" })),
    sendActivities: vi.fn(async () => []),
    updateActivity: vi.fn(async () => ({ id: "update" })),
    deleteActivity: vi.fn(async () => {}),
  } as unknown as MSTeamsTurnContext & {
    sendActivity: ReturnType<typeof vi.fn>;
  };
}

function createFakeFetch(handlers: Array<(url: string, init?: unknown) => unknown>) {
  const calls: Array<{ url: string; init?: unknown }> = [];
  const fetchImpl: MSTeamsSsoFetch = async (url, init) => {
    calls.push({ url, init });
    const handler = handlers.shift();
    if (!handler) {
      throw new Error("unexpected fetch call");
    }
    const response = handler(url, init) as {
      ok: boolean;
      status: number;
      body: unknown;
    };
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
      text: async () =>
        typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? ""),
    };
  };
  return { fetchImpl, calls };
}

function createBlockedSigninScenarios() {
  return [
    {
      name: "DM sender outside allowlist",
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-dm-aad",
      },
      expectedDropLog: "dropping signin invoke (dm sender not allowlisted)",
    },
    {
      name: "channel outside route allowlist",
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["blocked-channel-aad"],
            teams: {
              "team-allowlisted": {
                channels: {
                  "19:allowlisted@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-channel-aad",
        conversationType: "channel" as const,
        conversationId: "19:blocked-channel@thread.tacv2",
        teamId: "team-blocked",
        channelName: "General",
      },
      expectedDropLog: "dropping signin invoke (not in team/channel allowlist)",
    },
    {
      name: "group sender outside group allowlist",
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        userAadId: "blocked-group-aad",
        conversationType: "groupChat" as const,
        conversationId: "19:group-chat@thread.v2",
      },
      expectedDropLog: "dropping signin invoke (group sender not allowlisted)",
    },
  ];
}

describe("msteams signin invoke value parsers", () => {
  it("parses signin/tokenExchange values", () => {
    expect(
      parseSigninTokenExchangeValue({
        id: "flow-1",
        connectionName: "Graph",
        token: "eyJ...",
      }),
    ).toEqual({ id: "flow-1", connectionName: "Graph", token: "eyJ..." });
  });

  it("rejects non-object signin/tokenExchange values", () => {
    expect(parseSigninTokenExchangeValue(null)).toBeNull();
    expect(parseSigninTokenExchangeValue("nope")).toBeNull();
  });

  it("parses signin/verifyState values", () => {
    expect(parseSigninVerifyStateValue({ state: "123456" })).toEqual({ state: "123456" });
    expect(parseSigninVerifyStateValue({})).toEqual({ state: undefined });
    expect(parseSigninVerifyStateValue(null)).toBeNull();
  });
});

describe("getMSTeamsSsoUserToken", () => {
  it("returns service_error when Bot Framework token acquisition throws", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso, tokenProvider } = createSsoDeps({ fetchImpl });
    tokenProvider.getAccessToken.mockRejectedValueOnce(new Error("auth sdk unavailable"));

    const result = await getMSTeamsSsoUserToken({
      user: { userId: "aad-user-guid", channelId: "msteams" },
      connectionName: "GraphConnection",
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.message).toBe("Bot Framework token acquisition failed");
    }
    expect(calls).toHaveLength(0);
  });

  it("returns service_error when the User Token service request throws", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => {
        throw new Error("network unavailable");
      },
    ]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await getMSTeamsSsoUserToken({
      user: { userId: "aad-user-guid", channelId: "msteams" },
      connectionName: "GraphConnection",
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.status).toBe(503);
      expect(result.message).toBe("User Token service request failed");
    }
    expect(calls).toHaveLength(1);
  });

  it("rejects tokens returned for a different OAuth connection", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "OtherConnection",
          token: "delegated-graph-token",
        },
      }),
    ]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await getMSTeamsSsoUserToken({
      user: { userId: "aad-user-guid", channelId: "msteams" },
      connectionName: "GraphConnection",
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unexpected_response");
      expect(result.status).toBe(502);
      expect(result.message).toBe(
        "User Token service returned token for an unexpected OAuth connection",
      );
    }
  });
});

describe("handleSigninTokenExchangeInvoke", () => {
  it("exchanges the Teams token and persists the result", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result).toEqual({
      ok: true,
      token: "delegated-graph-token",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/api/usertoken/exchange");
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("connectionName=GraphConnection");
    expect(calls[0]?.url).toContain("channelId=msteams");

    const init = calls[0]?.init as {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    expect(init?.method).toBe("POST");
    expect(init?.headers?.Authorization).toBe("Bearer bf-service-token");
    expect(JSON.parse(init?.body ?? "{}")).toEqual({ token: "exchangeable-token" });

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
    expect(stored?.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("returns a service error when the User Token service rejects the exchange", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ ok: false, status: 502, body: "bad gateway" }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("service_error");
      expect(result.status).toBe(502);
      expect(result.message).toContain("bad gateway");
    }
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });

  it("refuses to exchange without a user id", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_user");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects token exchanges for a different OAuth connection", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso, tokenProvider } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "OtherConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unexpected_response");
      expect(result.message).toBe("signin/tokenExchange OAuth connection mismatch");
    }
    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("rejects token exchange responses for a different OAuth connection", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "OtherConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninTokenExchangeInvoke({
      value: { id: "flow-1", connectionName: "GraphConnection", token: "exchangeable-token" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unexpected_response");
      expect(result.status).toBe(502);
      expect(result.message).toBe(
        "User Token service returned token for an unexpected OAuth connection",
      );
    }
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });
});

describe("handleSigninVerifyStateInvoke", () => {
  it("fetches the user token for the magic code and persists it", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-2",
          expiration: "2031-02-03T04:05:06Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });

    const result = await handleSigninVerifyStateInvoke({
      value: { state: "654321" },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toContain("/api/usertoken/GetToken");
    expect(calls[0]?.url).toContain("code=654321");
    const init = calls[0]?.init as { method?: string };
    expect(init?.method).toBe("GET");

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-2");
  });

  it("rejects invocations without a state code", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const result = await handleSigninVerifyStateInvoke({
      value: { state: "   " },
      user: { userId: "aad-user-guid", channelId: "msteams" },
      deps: sso,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_state");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("msteams signin invoke handler registration", () => {
  beforeAll(() => {
    installMSTeamsTestRuntime();
  });

  const blockedSigninScenarios = createBlockedSigninScenarios();
  const invokeVariants = [
    {
      name: "signin/tokenExchange" as const,
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    },
    {
      name: "signin/verifyState" as const,
      value: { state: "112233" },
    },
    {
      name: "signin/failure" as const,
      value: { code: "resourcematchfailed", message: "Resource match failed" },
    },
  ];

  it("acks signin invokes even when sso is not configured", async () => {
    const deps = createDepsWithoutSso();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "Graph", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
        value: expect.objectContaining({ status: 200 }),
      }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(deps.log.debug).toHaveBeenCalledWith(
      "signin invoke received but msteams.sso is not configured",
      expect.objectContaining({ name: "signin/tokenExchange" }),
    );
  });

  for (const invoke of invokeVariants) {
    for (const scenario of blockedSigninScenarios) {
      it(`does not process ${invoke.name} for ${scenario.name}`, async () => {
        const { fetchImpl, calls } = createFakeFetch([
          () => ({
            ok: true,
            status: 200,
            body: {
              channelId: "msteams",
              connectionName: "GraphConnection",
              token: "delegated-graph-token",
              expiration: "2030-01-01T00:00:00Z",
            },
          }),
        ]);
        const { sso, tokenStore } = createSsoDeps({ fetchImpl });
        const deps = createDepsWithoutSso({ cfg: scenario.cfg, sso });
        const { handler } = createActivityHandler();
        const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
          run: NonNullable<MSTeamsActivityHandler["run"]>;
        };

        const ctx = createSigninInvokeContext({
          name: invoke.name,
          value: invoke.value,
          ...scenario.context,
        });

        await registered.run(ctx);

        expect(ctx.sendActivity).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "invokeResponse",
            value: expect.objectContaining({ status: 200 }),
          }),
        );
        expect(calls).toHaveLength(0);
        const stored = await tokenStore.get({
          connectionName: "GraphConnection",
          userId: scenario.context.userAadId ?? "aad-user-guid",
        });
        expect(stored).toBeNull();
        expect(deps.log.debug).toHaveBeenCalledWith(
          scenario.expectedDropLog,
          expect.objectContaining({ name: invoke.name }),
        );
      });
    }
  }

  it("invokes the token exchange handler when sso is configured", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const { deps, registered } = createRegisteredSsoHandler(sso);

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "invokeResponse",
        value: expect.objectContaining({ status: 200 }),
      }),
    );
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso token exchanged",
      expect.objectContaining({ userId: "aad-user-guid", hasExpiry: true }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-graph-token");
  });

  it("falls back to the Teams channel user id for tokenExchange invokes", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({ ok: false, status: 404, body: "aad user not found" }),
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-graph-token",
          expiration: "2030-01-01T00:00:00Z",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const { deps, registered } = createRegisteredSsoHandler(sso);

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[1]?.url).toContain("userId=bf-user");
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso token exchanged",
      expect.objectContaining({ userId: "bf-user", hasExpiry: true }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "bf-user",
    });
    expect(stored?.token).toBe("delegated-graph-token");
  });

  it("logs an error when the token exchange fails", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({ ok: false, status: 400, body: "bad request" }),
      () => ({ ok: false, status: 400, body: "bad request" }),
    ]);
    const { sso } = createSsoDeps({ fetchImpl });
    const { deps, registered } = createRegisteredSsoHandler(sso);

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "GraphConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invokeResponse" }),
    );
    expect(deps.log.error).toHaveBeenCalledWith(
      "msteams sso token exchange failed",
      expect.objectContaining({ code: "unexpected_response", status: 400 }),
    );
  });

  it("does not clear sign-in challenges for tokenExchange connection mismatches", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const clearSsoSignInChallenge = vi.fn();
    const deps = createDepsWithoutSso({ sso, clearSsoSignInChallenge });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/tokenExchange",
      value: { id: "x", connectionName: "OtherConnection", token: "exchangeable" },
    });

    await registered.run(ctx);

    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invokeResponse" }),
    );
    expect(calls).toHaveLength(0);
    expect(clearSsoSignInChallenge).not.toHaveBeenCalled();
    expect(deps.log.error).toHaveBeenCalledWith(
      "msteams sso token exchange failed",
      expect.objectContaining({
        code: "unexpected_response",
        message: "signin/tokenExchange OAuth connection mismatch",
      }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored).toBeNull();
  });

  it("logs signin/failure invokes from Teams", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const clearSsoSignInChallenge = vi.fn();
    const deps = createDepsWithoutSso({ sso, clearSsoSignInChallenge });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/failure",
      value: {
        code: "resourcematchfailed",
        message: "Resource match failed",
        connectionName: "GraphConnection",
        token: "not logged",
      },
    });

    await registered.run(ctx);

    expect(calls).toHaveLength(0);
    expect(ctx.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({ type: "invokeResponse" }),
    );
    expect(deps.log.warn).toHaveBeenCalledWith("msteams sso signin failure", {
      code: "resourcematchfailed",
      message: "Resource match failed",
      connectionName: "GraphConnection",
    });
    expect(clearSsoSignInChallenge).not.toHaveBeenCalled();
  });

  it("handles signin/verifyState via the magic-code flow", async () => {
    const { fetchImpl } = createFakeFetch([
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-3",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/verifyState",
      value: { state: "112233" },
    });

    await registered.run(ctx);

    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso verifyState succeeded",
      expect.objectContaining({ userId: "aad-user-guid" }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "aad-user-guid",
    });
    expect(stored?.token).toBe("delegated-token-3");
  });

  it("falls back to the Teams channel user id for verifyState invokes", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({ ok: false, status: 404, body: "aad user not found" }),
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-4",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninInvokeContext({
      name: "signin/verifyState",
      value: { state: "112233" },
    });

    await registered.run(ctx);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("code=112233");
    expect(calls[1]?.url).toContain("userId=bf-user");
    expect(calls[1]?.url).toContain("code=112233");
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso verifyState succeeded",
      expect.objectContaining({ userId: "bf-user" }),
    );
    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "bf-user",
    });
    expect(stored?.token).toBe("delegated-token-4");
  });

  it("handles browser fallback magic codes sent as normal messages", async () => {
    const { fetchImpl, calls } = createFakeFetch([
      () => ({ ok: false, status: 404, body: "not found for aad id" }),
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-from-code",
        },
      }),
    ]);
    const { sso, tokenStore } = createSsoDeps({ fetchImpl });
    const clearSsoSignInChallenge = vi.fn();
    const deps = createDepsWithoutSso({
      sso,
      hasSsoSignInChallenge: vi.fn(() => true),
      clearSsoSignInChallenge,
    });
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const ctx = createSigninCodeMessageContext({ text: "<div>156372</div>" });

    await registered.run(ctx);

    expect(run).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("userId=aad-user-guid");
    expect(calls[0]?.url).toContain("code=156372");
    expect(calls[1]?.url).toContain("userId=bf-user");
    expect(calls[1]?.url).toContain("code=156372");
    expect(ctx.sendActivity).toHaveBeenCalledWith(
      "Microsoft Teams delegated auth is connected. Retry the tool now.",
    );
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso magic-code verification succeeded",
      expect.objectContaining({ userId: "bf-user" }),
    );
    expect(clearSsoSignInChallenge).toHaveBeenCalledWith(ctx.activity);

    const stored = await tokenStore.get({
      connectionName: "GraphConnection",
      userId: "bf-user",
    });
    expect(stored?.token).toBe("delegated-token-from-code");
  });

  it("passes six-digit messages to the normal Teams handler without a pending sign-in challenge", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const ctx = createSigninCodeMessageContext({ text: "156372" });

    await registered.run(ctx);

    expect(calls).toHaveLength(0);
    expect(ctx.sendActivity).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes later six-digit messages after clearing a sign-in challenge via one user-id alias", async () => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher
      .mockImplementationOnce(async (params: unknown) => {
        const typedParams = params as {
          ctxPayload?: unknown;
          replyOptions?: { pluginAuth?: unknown };
        };
        const auth = typedParams.replyOptions?.pluginAuth as
          | {
              getDelegatedAccessToken?: (request: {
                provider: string;
                audience: string;
                scopes: string[];
              }) => Promise<unknown>;
            }
          | undefined;
        await auth?.getDelegatedAccessToken?.({
          provider: "msteams",
          audience: "api://downstream-tools",
          scopes: ["downstream.access"],
        });
        return { queuedFinal: false, counts: {}, capturedCtxPayload: typedParams.ctxPayload };
      })
      .mockImplementationOnce(async (params: unknown) => {
        const typedParams = params as { ctxPayload?: unknown };
        return { queuedFinal: false, counts: {}, capturedCtxPayload: typedParams.ctxPayload };
      });
    const { fetchImpl, calls } = createFakeFetch([
      () => ({ ok: false, status: 404, body: "not found before consent for aad id" }),
      () => ({ ok: false, status: 404, body: "not found before consent for channel user id" }),
      () => ({
        ok: true,
        status: 200,
        body: { signInLink: "https://signin.example.test/start" },
      }),
      () => ({
        ok: true,
        status: 200,
        body: {
          channelId: "msteams",
          connectionName: "GraphConnection",
          token: "delegated-token-from-code",
        },
      }),
    ]);
    const { sso } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "open",
            allowFrom: ["*"],
            sso: { enabled: true, connectionName: "GraphConnection" },
          },
        },
      } as OpenClawConfig,
      sso,
    });
    const { handler, run } = createDispatchingActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    const initialMessage = createSigninCodeMessageContext({
      text: "run delegated tool",
      userAadId: "aad-user-guid",
      userBfId: "bf-user",
    });
    await registered.run(initialMessage);
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    expect(
      (
        runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0] as {
          replyOptions?: { pluginAuth?: unknown };
        }
      )?.replyOptions?.pluginAuth,
    ).toBeDefined();
    expect(initialMessage.sendActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("https://signin.example.test/start"),
      }),
    );

    const aadOnlyCode = createSigninInvokeContext({
      name: "signin/verifyState",
      value: { state: "156372" },
      userAadId: "aad-user-guid",
      userBfId: "",
    });
    await registered.run(aadOnlyCode);
    expect(deps.log.info).toHaveBeenCalledWith(
      "msteams sso verifyState succeeded",
      expect.objectContaining({ userId: "aad-user-guid" }),
    );

    const channelUserOnlyMessage = createSigninCodeMessageContext({
      text: "238232",
      userAadId: "",
      userBfId: "bf-user",
    });
    await registered.run(channelUserOnlyMessage);

    expect(calls).toHaveLength(4);
    expect(run).toHaveBeenCalledTimes(2);
    expect(channelUserOnlyMessage.sendActivity).not.toHaveBeenCalledWith(
      expect.stringContaining("sign-in code could not be verified"),
    );
  });

  it("passes non-code messages to the normal Teams handler", async () => {
    const { fetchImpl, calls } = createFakeFetch([]);
    const { sso } = createSsoDeps({ fetchImpl });
    const deps = createDepsWithoutSso({ sso });
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };

    await registered.run(createSigninCodeMessageContext({ text: "hello 156372" }));

    expect(calls).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
