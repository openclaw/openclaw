import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("stays active until aborted", async () => {
    const abort = new AbortController();
    const task = runProvider(abort);

    let taskSettled = false;
    void task.then(
      () => {
        taskSettled = true;
      },
      () => {
        taskSettled = true;
      },
    );
    await waitForMSTeamsTestState(() => {
      expect(routeState.routes).toHaveLength(1);
    });
    await Promise.resolve();
    expect(taskSettled).toBe(false);

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected Teams monitor app after startup abort");
    }
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

  it.each(["signin/tokenExchange", "signin/verifyState"] as const)(
    "gates the real SDK %s route and persists its signin event",
    async (name) => {
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
          name === "signin/tokenExchange"
            ? {
                method: "post",
                path: "/api/usertoken/exchange",
                query: { channelId: "msteams", userId: "29:user", connectionName: "graph" },
                data: { token: "fixture-user-token" },
              }
            : {
                method: "get",
                path: "/api/usertoken/GetToken",
                query: {
                  channelId: "msteams",
                  userId: "29:user",
                  connectionName: "graph",
                  code: "fixture-state",
                },
                data: undefined,
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
    },
  );

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
    { name: "signin/tokenExchange", enabled: true },
    { name: "signin/verifyState", enabled: true },
    { name: "signin/tokenExchange", enabled: false },
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
      allowFrom: ["Alice", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      groupAllowFrom: ["Bob", "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198"],
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
      allowFrom: ["Alice"],
      groupAllowFrom: ["Bob"],
    });

    const task = runProvider(abort, cfg);

    await waitForMSTeamsTestState(() => {
      expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(1, {
      cfg,
      entries: ["Alice"],
    });
    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(2, {
      cfg,
      entries: ["Bob"],
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual(["bob-aad"]);

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
});
