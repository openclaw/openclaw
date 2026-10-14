import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolvePluginRoutePathContext } from "openclaw/plugin-sdk/gateway-config-runtime";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  getMSTeamsIngressMockState,
  gateIngressAcceptThenDispatch,
} from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  createMSTeamsActivityHandler,
  isSigninInvokeAuthorized,
  isCardActionInvokeAuthorized,
  runMSTeamsFileConsentInvokeHandler,
  processSdkActivity,
  nativeSdkState,
  loadMSTeamsSdkWithAuth,
  ssoTokenStore,
  resolveAllowlistMocks,
  routeState,
  resetMSTeamsMonitorMocks,
} from "./monitor-lifecycle.test-support.js";
import { createNativeSsoProcessor, createSigninEvent } from "./monitor-sso.test-helpers.js";
import { monitorMSTeamsProvider } from "./monitor.js";
import type { MSTeamsPollStore } from "./polls.js";

async function waitForMSTeamsTestState(assertion: () => void | Promise<void>): Promise<void> {
  await routeState.ready.promise;
  await assertion();
}

function runProvider(
  abort: AbortController,
  cfg = createConfig(),
  overrides: Partial<Parameters<typeof monitorMSTeamsProvider>[0]> = {},
) {
  return monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    ...createStores(),
    ...overrides,
  });
}

async function resolveSdkApp() {
  const result = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
  if (!result) {
    throw new Error("expected loadMSTeamsSdkWithAuth result");
  }
  return (await result).app;
}

function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0] as
    | { cfg?: OpenClawConfig }
    | undefined;
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

function requireRegisteredMSTeamsMediaMaxBytes(): number {
  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0];
  if (!registered) {
    throw new Error("expected registered MSTeams handler dependencies");
  }
  return registered.mediaMaxBytes;
}

describe("monitorMSTeamsProvider lifecycle", () => {
  afterEach(resetMSTeamsMonitorMocks);

  it.each(["default", "support"])(
    "keeps %s routing and durable ingress identity isolated",
    async (accountId) => {
      const abort = new AbortController();
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, {
        accounts: {
          support: {
            appId: "support-app",
            appPassword: "support-secret",
            webhook: { path: "/teams/support" },
          },
        },
      });
      const task = runProvider(abort, cfg, { accountId });
      try {
        await routeState.ready.promise;
        expect(routeState.routes).toHaveLength(1);
        expect(routeState.routes[0]).toMatchObject({
          accountId,
          path: accountId === "default" ? "/api/messages" : "/teams/support",
        });
        expect(getMSTeamsIngressMockState().instances.at(-1)?.options.accountId).toBe(
          accountId === "default" ? "app-id" : "support-app",
        );
        expect(createMSTeamsActivityHandler.mock.calls[0]?.[0].accountId).toBe(accountId);
      } finally {
        abort.abort();
        await task;
      }
    },
  );

  it("does not reopen a retired default bot inbox through a reused logical account id", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      appId: undefined,
      appPassword: undefined,
      accounts: {
        "retired-app": { appId: "new-bot-app", appPassword: "synthetic-secret" },
      },
    });
    const task = runProvider(abort, cfg, { accountId: "retired-app" });
    try {
      await routeState.ready.promise;
      expect(getMSTeamsIngressMockState().instances.at(-1)?.options.accountId).toBe("new-bot-app");
      expect(createMSTeamsActivityHandler.mock.calls[0]?.[0].accountId).toBe("retired-app");
    } finally {
      abort.abort();
      await task;
    }
  });

  it("keeps default and two named routes independent through shutdown", async () => {
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      accounts: {
        support: { appId: "support-app", appPassword: "support-secret" },
        sales: { appId: "sales-app", appPassword: "sales-secret" },
      },
    });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const tasks: Array<ReturnType<typeof runProvider>> = [];
    const accountIds = ["default", "support", "sales"];
    try {
      for (const [index, accountId] of accountIds.entries()) {
        routeState.ready = createDeferred<void>();
        tasks.push(runProvider(controllers[index]!, cfg, { accountId }));
        await routeState.ready.promise;
      }
      expect(routeState.routes.map(({ accountId, path }) => ({ accountId, path }))).toEqual([
        { accountId: "default", path: "/api/messages" },
        { accountId: "support", path: "/api/messages/support" },
        { accountId: "sales", path: "/api/messages/sales" },
      ]);
      const ingresses = getMSTeamsIngressMockState().instances;
      controllers[1]!.abort();
      await tasks[1];
      expect(routeState.unregister).toHaveBeenCalledTimes(1);
      expect(routeState.routes.map(({ accountId }) => accountId)).toEqual(["default", "sales"]);
      expect(ingresses[1]?.stop).toHaveBeenCalledTimes(1);
      expect(ingresses[0]?.stop).not.toHaveBeenCalled();
      expect(ingresses[2]?.stop).not.toHaveBeenCalled();
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(tasks);
    }
  });

  it("rejects sibling webhook aliases before creating a listener", async () => {
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      accounts: {
        support: {
          appId: "support-app",
          appPassword: "support-secret",
          webhook: { path: "/api/messages/" },
        },
      },
    });
    await expect(runProvider(new AbortController(), cfg, { accountId: "support" })).rejects.toThrow(
      "shared by accounts",
    );
    expect(loadMSTeamsSdkWithAuth).not.toHaveBeenCalled();
    expect(routeState.routes).toHaveLength(0);
  });

  it("prefers the Teams media limit over the agent default", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { mediaMaxMb: 12 });
    cfg.agents = { defaults: { mediaMaxMb: 3 } };

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalledTimes(1);
    });
    expect(requireRegisteredMSTeamsMediaMaxBytes()).toBe(12 * 1024 * 1024);

    abort.abort();
    await task;
  });

  it("falls back to the agent media limit when Teams has no override", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    cfg.agents = { defaults: { mediaMaxMb: 3 } };

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalledTimes(1);
    });
    expect(requireRegisteredMSTeamsMediaMaxBytes()).toBe(3 * 1024 * 1024);

    abort.abort();
    await task;
  });

  it("gates the real SDK token exchange route and persists its signin event", async () => {
    const name = "signin/tokenExchange";
    const { app: nativeApp, requests } = await createNativeSsoProcessor();
    nativeSdkState.app = nativeApp;
    const stored = createDeferred<void>();
    ssoTokenStore.save.mockImplementation(async () => {
      if (ssoTokenStore.save.mock.calls.length === 2) {
        stored.resolve();
      }
    });
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });

    const task = runProvider(abort, cfg);

    try {
      await waitForMSTeamsTestState(() => {
        expect(createMSTeamsActivityHandler).toHaveBeenCalled();
      });

      expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
        oauthDefaultConnectionName: "graph",
      });

      const app = await resolveSdkApp();
      expect(app.event).toHaveBeenCalledWith("signin", expect.any(Function));

      const event = createSigninEvent(name);
      const exchangeResult = await app.process(event);
      expect(exchangeResult).toEqual({ status: 200 });
      expect(processSdkActivity).toHaveBeenCalledExactlyOnceWith(event);
      expect(requests).toEqual([
        {
          method: "get",
          path: "/api/usertoken/GetToken",
          query: { channelId: "msteams", userId: "29:user", connectionName: "graph" },
          data: undefined,
        },
        {
          method: "post",
          path: "/api/usertoken/exchange",
          query: { channelId: "msteams", userId: "29:user", connectionName: "graph" },
          data: { token: "fixture-user-token" },
        },
      ]);
      await stored.promise;
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(2);
      expect(ssoTokenStore.save).toHaveBeenCalledTimes(2);
      expect(ssoTokenStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionName: "graph",
          userId: "29:user",
          token: "delegated-graph-token",
          expiresAt: "2030-01-01T00:00:00Z",
        }),
      );
      expect(ssoTokenStore.save).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionName: "graph",
          userId: "aad-user",
          token: "delegated-graph-token",
          expiresAt: "2030-01-01T00:00:00Z",
        }),
      );
    } finally {
      abort.abort();
      await task;
    }
  });

  it("does not persist SDK SSO signin events when Teams sender policy denies them", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const signinHandler = app.event.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin",
    )?.[1];
    if (typeof signinHandler !== "function") {
      throw new Error("expected signin event handler");
    }

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await waitForMSTeamsTestState(() => {
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    });
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it.each([
    { name: "signin/verifyState", enabled: true },
    { name: "signin/verifyState", enabled: false },
  ] as const)(
    "blocks SDK $name before token lookup with SSO enabled=$enabled",
    async ({ name, enabled }) => {
      const { app: nativeApp, requests } = await createNativeSsoProcessor();
      nativeSdkState.app = nativeApp;
      const abort = new AbortController();
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, {
        sso: { enabled, connectionName: "graph" },
      });
      isSigninInvokeAuthorized.mockResolvedValueOnce(!enabled);

      const task = runProvider(abort, cfg);

      try {
        await waitForMSTeamsTestState(() => {
          expect(createMSTeamsActivityHandler).toHaveBeenCalled();
        });

        const app = await resolveSdkApp();
        const result = await app.process(createSigninEvent(name, "29:blocked"));

        expect(result).toEqual({ status: 200, body: {} });
        expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
        expect(processSdkActivity).not.toHaveBeenCalled();
        expect(requests).toEqual([]);
        expect(ssoTokenStore.save).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await task;
      }
    },
  );

  it("falls through non-feedback message.submit invokes to activity dispatch", async () => {
    const abort = new AbortController();
    const task = runProvider(abort);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const messageSubmitHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "message.submit",
    )?.[1];
    const activityHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "activity",
    )?.[1];
    if (typeof messageSubmitHandler !== "function" || typeof activityHandler !== "function") {
      throw new Error("expected message.submit and activity handlers");
    }

    const activity = {
      type: "invoke",
      name: "message/submitAction",
      value: { actionName: "nonFeedbackAction" },
    };
    const next = vi.fn(async () => {});
    await messageSubmitHandler({ activity, next });
    expect(next).toHaveBeenCalledTimes(1);

    const registeredHandler = createMSTeamsActivityHandler.mock.results[0]?.value;
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    const run = vi.mocked(registeredHandler);
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "activity-aad-group" }));
    await activityHandler({
      activity,
      api: { teams: { getById: getTeamDetails } },
      send: vi.fn(async () => undefined),
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ activity }));
    const adaptedContext = run.mock.calls[0]?.[0] as
      | { getTeamDetails?: (teamId: string) => Promise<{ aadGroupId?: string }> }
      | undefined;
    await expect(adaptedContext?.getTeamDetails?.("activity-team-id")).resolves.toEqual({
      aadGroupId: "activity-aad-group",
    });
    expect(getTeamDetails).toHaveBeenCalledWith("activity-team-id");

    abort.abort();
    await task;
  });

  it("acks file-consent invokes before upload work settles", async () => {
    let releaseUpload: (() => void) | undefined;
    const uploadWork = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    runMSTeamsFileConsentInvokeHandler.mockReturnValueOnce(uploadWork);

    const abort = new AbortController();
    const task = runProvider(abort);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const fileConsentHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "file.consent.accept",
    )?.[1];
    if (typeof fileConsentHandler !== "function") {
      throw new Error("expected file consent accept handler");
    }

    expect(fileConsentHandler({ activity: { type: "invoke", name: "fileConsent/invoke" } })).toBe(
      undefined,
    );
    expect(runMSTeamsFileConsentInvokeHandler).toHaveBeenCalledTimes(1);
    releaseUpload?.();
    await uploadWork;

    abort.abort();
    await task;
  });

  it("acks non-poll card actions after durable admission, before agent dispatch settles", async () => {
    const abort = new AbortController();
    const task = runProvider(abort);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }
    const registeredHandler = createMSTeamsActivityHandler.mock.results[0]?.value;
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    const dispatchWork = new Promise<void>(() => {});
    const run = vi.mocked(registeredHandler).mockReturnValueOnce(dispatchWork);

    const ingress = getMSTeamsIngressMockState().instances[0];
    if (!ingress) {
      throw new Error("expected Teams ingress");
    }
    let releaseAppend: (() => void) | undefined;
    const appendWork = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    gateIngressAcceptThenDispatch(ingress, appendWork);

    const responseWork = cardActionHandler({
      activity: {
        id: "activity-card-action",
        type: "invoke",
        name: "adaptiveCard/action",
        conversation: { id: "conversation-card-action", conversationType: "personal" },
        value: { action: { data: { action: "nonPoll" } } },
      },
    });

    let responseSettled = false;
    void responseWork.then(() => {
      responseSettled = true;
    });
    await Promise.resolve();
    expect(responseSettled).toBe(false);

    releaseAppend?.();
    const response = await responseWork;

    expect(response).toMatchObject({ statusCode: 200, value: "OK" });
    expect(run).toHaveBeenCalledTimes(1);

    abort.abort();
    await task;
  });

  it("gates poll card votes before recording them", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:channel@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };
    isCardActionInvokeAuthorized.mockResolvedValueOnce(false);

    const task = runProvider(abort, cfg, { pollStore });

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Not authorized." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).not.toHaveBeenCalled();
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("rejects poll card votes from the wrong conversation", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:expected@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };

    const task = runProvider(abort, cfg, { pollStore });

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    const app = await resolveSdkApp();
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:other@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Poll not found." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).toHaveBeenCalledWith("poll-1");
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("does not resolve user allowlists by display name unless name matching is enabled", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      allowFrom: ["19:group@thread.tacv2", "Alice", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      groupAllowFrom: [
        "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
        "Bob",
        "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198",
      ],
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockResolvedValueOnce({
      teams: {
        "team-id": {
          channels: {
            "channel-id": {},
          },
        },
      },
      mapping: ["Product/Roadmap→team-id/channel-id"],
      unresolved: [],
    });

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
    expect(resolveAllowlistMocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      teamIdMode: "bot-framework",
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
      "19:MiXeD-group@thread.tacv2",
      "50a1a0ed-4ff2-4164-a219-55518990c198",
    ]);
    expect(registeredCfg.channels?.msteams?.teams).toEqual({
      "team-id": {
        channels: {
          "channel-id": {},
        },
      },
    });

    abort.abort();
    await task;
  });

  it("resolves user allowlists when name matching is enabled", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist
      .mockResolvedValueOnce([{ input: "Alice", resolved: true, id: "alice-aad" }])
      .mockResolvedValueOnce([{ input: "Bob", resolved: true, id: "bob-aad" }]);

    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["19:group@thread.tacv2", "Alice"],
      groupAllowFrom: [
        "19:group@thread.tacv2;messageid=1740123456789",
        "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
        "19:modern-group@thread.v2;messageid=1740123456789",
        "19:legacy@thread.skype",
        "Bob",
      ],
    });

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(1, {
      cfg,
      accountId: "default",
      entries: ["Alice"],
    });
    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(2, {
      cfg,
      accountId: "default",
      entries: ["Bob"],
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
      "19:group@thread.tacv2",
      "19:MiXeD-group@thread.tacv2",
      "19:modern-group@thread.v2",
      "19:legacy@thread.skype",
      "bob-aad",
    ]);

    abort.abort();
    await task;
  });

  it("keeps only stable allowlist entries when Graph resolution fails", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockRejectedValueOnce(
      new Error("Graph unavailable"),
    );
    const runtime = createRuntime();
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice", "accessGroup:operators", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      teams: {
        Mutable: {
          channels: {
            Roadmap: {},
          },
        },
        "19:stable-team@thread.tacv2": {
          channels: {
            "19:stable-channel@thread.tacv2": {},
          },
        },
      },
    });

    const task = runProvider(abort, cfg, { runtime });

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.allowFrom).toEqual([
      "accessGroup:operators",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.teams).toEqual({
      "19:stable-team@thread.tacv2": {
        channels: {
          "19:stable-channel@thread.tacv2": {},
        },
      },
    });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("mutable allowlist entries are disabled"),
    );

    abort.abort();
    await task;
  });

  it("preserves Graph-resolved sender identities in the group fallback", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
      { input: "Alice", resolved: true, id: "alice-aad" },
    ]);
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["19:fallback-group@thread.v2;messageid=1740123456789", "Alice"],
    });
    const abort = new AbortController();
    const task = runProvider(abort, cfg);
    try {
      await routeState.ready.promise;
      const registeredCfg = requireRegisteredMSTeamsConfig();
      expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
      expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
        "19:fallback-group@thread.v2",
        "alice-aad",
      ]);
      expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenCalledExactlyOnceWith({
        cfg,
        accountId: "default",
        entries: ["Alice"],
      });
    } finally {
      abort.abort();
      await task;
    }
  });
});

let gateway: Server;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;

function post(init: RequestInit = {}, path = "/api/messages") {
  return fetch(`http://127.0.0.1:${claim.port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer valid-token" },
    ...init,
  });
}

async function withMonitor(
  run: (abort: AbortController, task: ReturnType<typeof monitorMSTeamsProvider>) => Promise<void>,
  cfg = createConfig(),
) {
  const abort = new AbortController();
  const task = runProvider(abort, cfg);
  try {
    await routeState.ready.promise;
    await run(abort, task);
  } finally {
    abort.abort();
    await task;
  }
}

describe("Microsoft Teams Gateway webhook lifecycle", () => {
  beforeAll(async () => {
    claim = await acquireTestPortBlock({ offsets: [0] });
    gateway = createServer((req, res) => {
      const { canonicalPath } = resolvePluginRoutePathContext(
        new URL(req.url ?? "/", "http://localhost").pathname,
      );
      const route = routeState.routes.find(
        (entry) => resolvePluginRoutePathContext(entry.path ?? "/").canonicalPath === canonicalPath,
      );
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      routeState.responseWork = Promise.resolve(route.handler(req, res));
    });
    gateway.listen(claim.port, "127.0.0.1");
    await once(gateway, "listening");
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      gateway.close((error) => (error ? reject(error) : resolve()));
    });
    await claim.release();
  });
  afterEach(resetMSTeamsMonitorMocks);

  it("registers the explicit compatibility listener", async () => {
    const cfg = createConfig();
    const endpoint = { port: 44978, host: "127.0.0.1" };
    updateMSTeamsConfig(cfg, { legacyWebhook: endpoint });
    await withMonitor(async () => {
      expect(routeState.routes[0]?.legacyListener).toEqual({
        ...endpoint,
        timeouts: { headers: 15000, request: 30000, socket: 30000 },
      });
      const response = await post();
      expect(response.status).toBe(200);
      await response.text();
    }, cfg);
    expect(routeState.unregister).toHaveBeenCalledOnce();
  });

  it.each(
    ["/api/:tenant/messages", "/healthz"].flatMap((path) => [
      { path, accountId: "default", accountKey: undefined },
      { path, accountId: "support-team", accountKey: "Support Team" },
    ]),
  )(
    "directs $accountId recovery when $path cannot serve Gateway-only callbacks",
    async ({ path, accountId, accountKey }) => {
      const cfg = createConfig();
      updateMSTeamsConfig(
        cfg,
        accountKey
          ? {
              accounts: {
                [accountKey]: {
                  appId: "support-app",
                  appPassword: "support-secret",
                  webhook: { path },
                },
              },
            }
          : { webhook: { path } },
      );
      await expect(
        monitorMSTeamsProvider({ cfg, accountId, runtime: createRuntime(), ...createStores() }),
      ).rejects.toThrow(
        accountKey
          ? `Set channels.msteams.accounts.${accountKey}.webhook.path to /api/messages/${accountId}`
          : "Set channels.msteams.webhook.path to /api/messages",
      );
      expect(routeState.routes).toEqual([]);
    },
  );

  it("stops ingress when Gateway route registration fails", async () => {
    routeState.fail = true;
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(),
        runtime: createRuntime(),
        ...createStores(),
      }),
    ).rejects.toThrow("route conflict");
    expect(getMSTeamsIngressMockState().instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("rejects requests without Bearer token before SDK route", async () => {
    await withMonitor(async () => {
      const unauthorized = await post({ headers: {} });
      expect(unauthorized.status).toBe(401);
      await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });
      expect((await post()).status).toBe(200);
    });
  });

  it.each([
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)("retains %s decoding and the decoded body limit", async (encoding, compress) => {
    await withMonitor(async () => {
      for (const [payload, status] of [
        ["ok", 200],
        ["x".repeat(1024 * 1024), 413],
      ] as const) {
        const response = await post({
          headers: {
            authorization: "Bearer valid-token",
            "content-type": "application/json",
            "content-encoding": encoding,
          },
          body: compress(JSON.stringify({ payload })),
        });
        expect(response.status).toBe(status);
        if (status === 413) {
          await expect(response.json()).resolves.toEqual({ error: "Payload too large" });
        } else {
          await response.text();
        }
      }
    });
  });

  it("drains active responses before releasing the route and rejects new work during stop", async () => {
    const gate = createDeferred<void>();
    routeState.responseGate = gate.promise;
    routeState.unregister.mockImplementation(() => gateway.closeAllConnections());
    await withMonitor(async (abort, task) => {
      let taskSettled = false;
      void task.then(
        () => {
          taskSettled = true;
        },
        () => {
          taskSettled = true;
        },
      );
      try {
        const response = post();
        await routeState.requestStarted.promise;
        let settled = false;
        const activeResponseWork = routeState.responseWork;
        void activeResponseWork?.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(taskSettled).toBe(false);
        abort.abort();
        const lateResponse = await post();
        expect(lateResponse.status).toBe(503);
        expect(lateResponse.headers.get("retry-after")).toBe("1");
        await lateResponse.text();
        expect(routeState.unregister).not.toHaveBeenCalled();
        expect(getMSTeamsIngressMockState().instances[0]?.stop).not.toHaveBeenCalled();
        gate.resolve();
        const completedResponse = await response;
        expect(completedResponse.status).toBe(200);
        await completedResponse.text();
        await activeResponseWork;
        expect(settled).toBe(true);
        const result = await task;
        expect(result.app).toBeTruthy();
        expect(taskSettled).toBe(true);
        expect(routeState.unregister).toHaveBeenCalledOnce();
        expect(getMSTeamsIngressMockState().instances[0]?.stop).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
      }
    });
  });

  it("bounds response drain to the shipped 30-second window", async () => {
    const gate = createDeferred<void>();
    routeState.responseGate = gate.promise;
    await withMonitor(async (abort, task) => {
      try {
        const response = post().then(
          () => "responded",
          () => "closed",
        );
        await routeState.requestStarted.promise;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        abort.abort();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(routeState.unregister).not.toHaveBeenCalled();
        expect(getMSTeamsIngressMockState().instances[0]?.stop).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await task;
        expect(routeState.unregister).toHaveBeenCalledOnce();
        await expect(response).resolves.toBe("closed");
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        gate.resolve();
        vi.useRealTimers();
      }
    });
  });

  it("requires the per-run QA token before parsing even when SDK auth is disabled", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubGlobal(Symbol.for("openclaw.msteams.privateQaRuntime"), {
      connectorUrl: "http://127.0.0.1:43123/",
      nonce: "synthetic-nonce",
      botToken: "synthetic-run-token",
    });
    await withMonitor(async () => {
      for (const token of ["private-qa", "synthetic-run-token"]) {
        const response = await post({
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{",
        });
        expect(response.status).toBe(token === "private-qa" ? 401 : 400);
        await response.text();
      }
    });
  });

  it.each([
    { path: "", endpoint: "/api/messages" },
    { path: "/teams/events", endpoint: "/teams/events" },
  ])("routes /api/messages with configured path $path", async ({ path, endpoint }) => {
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { webhook: { path } });
    await withMonitor(async () => {
      expect(routeState.routes[0]?.path).toBe(endpoint);
      expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
        messagingEndpoint: endpoint,
      });
      const response = await post();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ url: endpoint });
      if (endpoint !== "/api/messages") {
        routeState.routes = routeState.routes.filter((route) => route.path !== "/api/messages");
        const unregistered = await post();
        expect(unregistered.status).toBe(404);
        await unregistered.text();
      }
    }, cfg);
  });
});
