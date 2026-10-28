import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolvePluginRoutePathContext } from "openclaw/plugin-sdk/gateway-config-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getMSTeamsIngressMockState,
  gateIngressAcceptThenDispatch,
} from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
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
import { createMSTeamsPollStoreState, type MSTeamsPollStore } from "./polls.js";

function runProvider(
  abort: AbortController,
  cfg = createConfig(),
  overrides: Partial<Parameters<typeof monitorMSTeamsProvider>[0]> = {},
) {
  return monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    ...overrides,
  });
}

const monitors: Array<{ abort: AbortController; task: ReturnType<typeof runProvider> }> = [];
async function startMonitor(
  cfg = createConfig(),
  overrides: Partial<Parameters<typeof monitorMSTeamsProvider>[0]> = {},
) {
  const abort = new AbortController();
  const task = runProvider(abort, cfg, overrides);
  monitors.push({ abort, task });
  await routeState.ready.promise;
  return { abort, task };
}

afterEach(async () => {
  for (const { abort } of monitors) {
    abort.abort();
  }
  await Promise.all(monitors.splice(0).map(({ task }) => task));
  resetMSTeamsMonitorMocks();
  clearRuntimeConfigSnapshot();
});

async function resolveSdkApp() {
  const result = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
  if (!result) {
    throw new Error("expected loadMSTeamsSdkWithAuth result");
  }
  return (await result).app;
}

async function sdkHandler(name: string, registration: "on" | "event" = "on") {
  const app = await resolveSdkApp();
  const handler = app[registration].mock.calls.find(
    (call: [string, unknown]) => call[0] === name,
  )?.[1];
  if (typeof handler !== "function") {
    throw new Error("expected " + name + " handler");
  }
  return handler;
}

function messageHandler() {
  const handler = createMSTeamsActivityHandler.mock.results[0]?.value;
  if (!handler) {
    throw new Error("expected registered Teams handler");
  }
  return vi.mocked(handler);
}

function registeredDeps() {
  const deps = createMSTeamsActivityHandler.mock.calls[0]?.[0];
  if (!deps) {
    throw new Error("expected registered MSTeams handler dependencies");
  }
  return deps;
}

function teams(team: string, channel: string) {
  return { [team]: { channels: { [channel]: {} } } };
}

function configured(patch: Parameters<typeof updateMSTeamsConfig>[1]) {
  const cfg = createConfig();
  updateMSTeamsConfig(cfg, patch);
  return cfg;
}

describe("monitorMSTeamsProvider lifecycle", () => {
  it("does not reopen a retired default bot inbox through a reused logical account id", async () => {
    const cfg = configured({
      appId: undefined,
      appPassword: undefined,
      accounts: {
        "retired-app": { appId: "new-bot-app", appPassword: "synthetic-secret" },
      },
    });
    await startMonitor(cfg, { accountId: "retired-app" });
    expect(getMSTeamsIngressMockState().instances.at(-1)?.options.accountId).toBe("new-bot-app");
    expect(createMSTeamsActivityHandler.mock.calls[0]?.[0].accountId).toBe("retired-app");
  });

  it("keeps default and two named routes independent through shutdown", async () => {
    const cfg = configured({
      accounts: {
        support: {
          appId: "support-app",
          appPassword: "support-secret",
          webhook: { path: "/teams/support" },
        },
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
        { accountId: "support", path: "/teams/support" },
        { accountId: "sales", path: "/api/messages/sales" },
      ]);
      const ingresses = getMSTeamsIngressMockState().instances;
      expect(ingresses.map(({ options }) => options.accountId)).toEqual([
        "app-id",
        "support-app",
        "sales-app",
      ]);
      expect(createMSTeamsActivityHandler.mock.calls.map(([deps]) => deps.accountId)).toEqual(
        accountIds,
      );
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
    const cfg = configured({
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

  it.each([12, undefined])("resolves media limits with Teams override=%s", async (mediaMaxMb) => {
    const cfg = configured({ mediaMaxMb });
    cfg.agents = { defaults: { mediaMaxMb: 3 } };
    await startMonitor(cfg);
    expect(registeredDeps().mediaMaxBytes).toBe((mediaMaxMb ?? 3) * 1024 * 1024);
  });

  it("does not persist SDK SSO signin events when Teams sender policy denies them", async () => {
    const cfg = configured({
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    await startMonitor(cfg);

    const signinHandler = await sdkHandler("signin", "event");

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await routeState.ready.promise;
    expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(ssoTokenStore.save).not.toHaveBeenCalled();
  });

  it.each([
    { name: "signin/verifyState", enabled: true },
    { name: "signin/verifyState", enabled: false },
  ] as const)(
    "blocks SDK $name before token lookup with SSO enabled=$enabled",
    async ({ name, enabled }) => {
      const { app: nativeApp, requests } = await createNativeSsoProcessor();
      nativeSdkState.app = nativeApp;
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, {
        sso: { enabled, connectionName: "graph" },
      });
      isSigninInvokeAuthorized.mockResolvedValueOnce(!enabled);

      await startMonitor(cfg);

      const app = await resolveSdkApp();
      const result = await app.process(createSigninEvent(name, "29:blocked"));
      expect(result).toEqual({ status: 200, body: {} });
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
      expect(processSdkActivity).not.toHaveBeenCalled();
      expect(requests).toEqual([]);
      expect(ssoTokenStore.save).not.toHaveBeenCalled();
    },
  );

  it("falls through non-feedback message.submit invokes to activity dispatch", async () => {
    await startMonitor();

    const messageSubmitHandler = await sdkHandler("message.submit");
    const activityHandler = await sdkHandler("activity");

    const activity = {
      type: "invoke",
      name: "message/submitAction",
      value: { actionName: "nonFeedbackAction" },
    };
    const next = vi.fn(async () => {});
    await messageSubmitHandler({ activity, next });
    expect(next).toHaveBeenCalledTimes(1);

    const run = messageHandler();
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
  });

  it("acks file-consent invokes before upload work settles", async () => {
    const { promise: uploadWork, resolve: releaseUpload } = Promise.withResolvers<void>();
    runMSTeamsFileConsentInvokeHandler.mockReturnValueOnce(uploadWork);

    await startMonitor();

    const fileConsentHandler = await sdkHandler("file.consent.accept");

    expect(fileConsentHandler({ activity: { type: "invoke", name: "fileConsent/invoke" } })).toBe(
      undefined,
    );
    expect(runMSTeamsFileConsentInvokeHandler).toHaveBeenCalledTimes(1);
    releaseUpload?.();
    await uploadWork;
  });

  it("acks non-poll card actions after durable admission, before agent dispatch settles", async () => {
    await startMonitor();

    const cardActionHandler = await sdkHandler("card.action");
    const dispatchWork = new Promise<void>(() => {});
    const run = messageHandler().mockReturnValueOnce(dispatchWork);

    const ingress = getMSTeamsIngressMockState().instances[0];
    if (!ingress) {
      throw new Error("expected Teams ingress");
    }
    const { promise: appendWork, resolve: releaseAppend } = Promise.withResolvers<void>();
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
  });

  it.each([
    { authorized: false, reply: "Not authorized." },
    { authorized: true, reply: "Poll not found." },
  ])("rejects poll votes: $reply", async ({ authorized, reply }) => {
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
    isCardActionInvokeAuthorized.mockResolvedValueOnce(authorized);
    vi.mocked(createMSTeamsPollStoreState).mockReturnValueOnce(pollStore);
    await startMonitor();
    const cardActionHandler = await sdkHandler("card.action");
    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:other@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });
    expect(response).toMatchObject({ statusCode: 200, value: reply });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    if (authorized) {
      expect(pollStore.getPoll).toHaveBeenCalledWith("poll-1");
    } else {
      expect(pollStore.getPoll).not.toHaveBeenCalled();
    }
    expect(pollStore.recordVote).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "disabled",
      allowFrom: ["19:group@thread.tacv2", "Alice", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      groupAllowFrom: [
        "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
        "Bob",
        "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198",
      ],
      expectedAllow: ["40a1a0ed-4ff2-4164-a219-55518990c197"],
      expectedGroup: ["19:MiXeD-group@thread.tacv2", "50a1a0ed-4ff2-4164-a219-55518990c198"],
    },
    {
      mode: "enabled",
      allowFrom: ["19:group@thread.tacv2", "Alice"],
      groupAllowFrom: [
        "19:group@thread.tacv2;messageid=1740123456789",
        "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
        "19:modern-group@thread.v2;messageid=1740123456789",
        "19:legacy@thread.skype",
        "Bob",
      ],
      expectedAllow: ["alice-aad"],
      expectedGroup: [
        "19:group@thread.tacv2",
        "19:MiXeD-group@thread.tacv2",
        "19:modern-group@thread.v2",
        "19:legacy@thread.skype",
        "bob-aad",
      ],
    },
    {
      mode: "group fallback",
      allowFrom: ["19:fallback-group@thread.v2;messageid=1740123456789", "Alice"],
      groupAllowFrom: undefined,
      expectedAllow: ["alice-aad"],
      expectedGroup: ["19:fallback-group@thread.v2", "alice-aad"],
    },
  ])("resolves sender allowlists with name matching $mode", async (row) => {
    const enabled = row.mode !== "disabled";
    if (enabled) {
      resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
        { input: "Alice", resolved: true, id: "alice-aad" },
      ]);
      if (row.groupAllowFrom) {
        resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
          { input: "Bob", resolved: true, id: "bob-aad" },
        ]);
      }
    } else {
      resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockResolvedValueOnce({
        teams: teams("team-id", "channel-id"),
        mapping: ["Product/Roadmap→team-id/channel-id"],
        unresolved: [],
      });
    }
    await startMonitor(
      configured({
        dangerouslyAllowNameMatching: enabled,
        allowFrom: row.allowFrom,
        groupAllowFrom: row.groupAllowFrom,
        ...(!enabled ? { teams: teams("Product", "Roadmap") } : {}),
      }),
    );
    expect(registeredDeps().cfg.channels?.msteams).toMatchObject({
      allowFrom: row.expectedAllow,
      groupAllowFrom: row.expectedGroup,
      ...(!enabled ? { teams: teams("team-id", "channel-id") } : {}),
    });
    if (!enabled) {
      expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
    }
  });

  it("keeps only stable allowlist entries when Graph resolution fails", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockRejectedValueOnce(
      new Error("Graph unavailable"),
    );
    const runtime = createRuntime();
    const cfg = configured({
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice", "accessGroup:operators", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      teams: {
        ...teams("Mutable", "Roadmap"),
        ...teams("19:stable-team@thread.tacv2", "19:stable-channel@thread.tacv2"),
      },
    });

    await startMonitor(cfg, { runtime });

    expect(registeredDeps().cfg.channels?.msteams?.allowFrom).toEqual([
      "accessGroup:operators",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(registeredDeps().cfg.channels?.msteams?.teams).toEqual(
      teams("19:stable-team@thread.tacv2", "19:stable-channel@thread.tacv2"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("mutable allowlist entries are disabled"),
    );
  });

  it("keeps unresolved name-only allowlists configured so they do not fall back or widen", async () => {
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["Bob Builder"],
      teams: { Engineering: {} },
    });
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockRejectedValueOnce(
      new Error("Graph unavailable"),
    );

    await startMonitor(cfg);

    // The operator's stored configuration keeps its original entries; only the in-memory
    // projection handed to the handler carries the placeholder.
    expect(cfg.channels?.msteams?.groupAllowFrom).toEqual(["Bob Builder"]);
    expect(cfg.channels?.msteams?.teams).toEqual({ Engineering: {} });

    const registered = registeredDeps().cfg.channels?.msteams;
    expect(registered?.groupAllowFrom).toEqual([
      "19:openclaw-unresolved-allowlist@thread.unresolved",
    ]);
    expect(Object.keys(registered?.teams ?? {})).toHaveLength(1);
    expect(Object.keys(registered?.teams ?? {})).not.toContain("*");
  });

  const startupAllowlists = {
    allowFrom: ["user:40a1a0ed-4ff2-4164-a219-55518990c197"],
    groupAllowFrom: ["msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198"],
    teams: { ...teams("Product", "Roadmap"), "*": {} },
  };
  const resolvedTeams = { ...teams("19:product@thread.tacv2", "19:roadmap@thread.tacv2"), "*": {} };
  function allowlistConfig(
    accountId: string,
    allowlists: Parameters<typeof updateMSTeamsConfig>[1],
    inherited = false,
  ) {
    if (accountId === "default") {
      return configured(allowlists);
    }
    const support = {
      appId: "support-app",
      appPassword: "support-secret",
      webhook: { path: "/teams/support" },
    };
    return configured(
      inherited
        ? { ...allowlists, accounts: { support } }
        : { accounts: { support: { ...support, ...allowlists } } },
    );
  }
  function reloadUnrelatedSetting(cfg: ReturnType<typeof createConfig>) {
    setRuntimeConfigSnapshot({
      ...structuredClone(cfg),
      agents: { defaults: { userTimezone: "UTC" } },
    });
  }
  function handlerAllowlists() {
    const msteams = registeredDeps().readConfig?.().channels?.msteams;
    return {
      allowFrom: msteams?.allowFrom,
      groupAllowFrom: msteams?.groupAllowFrom,
      teams: msteams?.teams,
    };
  }

  it.each([
    { name: "default", accountId: "default", inherited: false },
    { name: "named", accountId: "support", inherited: false },
    { name: "inheriting named", accountId: "support", inherited: true },
  ])(
    "keeps the $name account's startup allowlists after an unrelated reload and applies each edit",
    async ({ accountId, inherited }) => {
      resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockResolvedValueOnce({
        teams: resolvedTeams,
        mapping: ["Product/Roadmap→19:product@thread.tacv2/19:roadmap@thread.tacv2"],
        unresolved: [],
      });
      const cfg = allowlistConfig(accountId, startupAllowlists, inherited);
      setRuntimeConfigSnapshot(cfg);
      await startMonitor(cfg, { accountId });

      reloadUnrelatedSetting(cfg);
      expect(handlerAllowlists()).toEqual({
        allowFrom: ["40a1a0ed-4ff2-4164-a219-55518990c197"],
        groupAllowFrom: ["50a1a0ed-4ff2-4164-a219-55518990c198"],
        teams: resolvedTeams,
      });

      // Each input edit restarts the channel; until then the edited lists apply as written.
      for (const edit of [
        { allowFrom: [] },
        { groupAllowFrom: ["60a1a0ed-4ff2-4164-a219-55518990c199"] },
        { teams: teams("Product", "Roadmap") },
      ]) {
        const edited = { ...startupAllowlists, ...edit };
        setRuntimeConfigSnapshot(allowlistConfig(accountId, edited, inherited));
        expect(handlerAllowlists()).toEqual(edited);
      }
    },
  );

  it("does not invent Teams config after channels.msteams is removed", async () => {
    const cfg = createConfig();
    setRuntimeConfigSnapshot(cfg);
    await startMonitor(cfg);

    setRuntimeConfigSnapshot({ ...structuredClone(cfg), channels: {} });
    expect(registeredDeps().readConfig?.().channels?.msteams).toBeUndefined();
  });

  it("keeps startup-resolved sender names resolved after an unrelated reload", async () => {
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
      { input: "Alice", resolved: true, id: "alice-aad" },
    ]);
    const cfg = configured({ dangerouslyAllowNameMatching: true, allowFrom: ["Alice"] });
    setRuntimeConfigSnapshot(cfg);
    await startMonitor(cfg);

    reloadUnrelatedSetting(cfg);
    expect(handlerAllowlists().allowFrom).toEqual(["alice-aad"]);

    // Turning name matching off is an allowlist edit, so the resolved ID stops applying.
    setRuntimeConfigSnapshot(
      configured({ dangerouslyAllowNameMatching: false, allowFrom: ["Alice"] }),
    );
    expect(handlerAllowlists().allowFrom).toEqual(["Alice"]);
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
        monitorMSTeamsProvider({ cfg, accountId, runtime: createRuntime() }),
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
        await task;
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
    const cfg = configured({ webhook: { path } });
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
