import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolvePluginRoutePathContext } from "openclaw/plugin-sdk/gateway-config-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { acquireTestPortBlock } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  createMSTeamsActivityHandler,
  loadMSTeamsSdkWithAuth,
  resolveAllowlistMocks,
  routeState,
  resetMSTeamsMonitorMocks,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";

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

function configured(settings: Parameters<typeof updateMSTeamsConfig>[1]) {
  const cfg = createConfig();
  updateMSTeamsConfig(cfg, settings);
  return cfg;
}
function registeredDeps() {
  const deps = createMSTeamsActivityHandler.mock.calls[0]?.[0];
  if (!deps) {
    throw new Error("expected Teams handler");
  }
  return deps;
}
function teams(team: string, channel: string) {
  return { [team]: { channels: { [channel]: {} } } };
}
const backportMonitors: Array<{ abort: AbortController; task: ReturnType<typeof runProvider> }> =
  [];
async function startMonitor(
  cfg = createConfig(),
  overrides: Partial<Parameters<typeof monitorMSTeamsProvider>[0]> = {},
) {
  const abort = new AbortController();
  const task = runProvider(abort, cfg, overrides);
  backportMonitors.push({ abort, task });
  await routeState.ready.promise;
  return { abort, task };
}

let gateway: Server;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>>;

function post(init: RequestInit = {}, path = "/api/messages") {
  return fetch(`http://127.0.0.1:${claim.port}${path}`, {
    method: "POST",
    headers: { authorization: "Bearer valid-token" },
    ...init,
  });
}

describe("monitorMSTeamsProvider account routing and config reload", () => {
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
  afterEach(async () => {
    for (const { abort } of backportMonitors) {
      abort.abort();
    }
    await Promise.all(backportMonitors.splice(0).map(({ task }) => task));
    resetMSTeamsMonitorMocks();
    clearRuntimeConfigSnapshot();
  });

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
    { supportPath: "/api/messages", supportEnabled: true, defaultAlias: false },
    { supportPath: "/api/messages", supportEnabled: false, defaultAlias: true },
    { supportPath: undefined, supportEnabled: true, defaultAlias: true },
  ])(
    "serves the default /api/messages alias=$defaultAlias beside support path=$supportPath enabled=$supportEnabled",
    async ({ supportPath, supportEnabled, defaultAlias }) => {
      const cfg = configured({
        webhook: { path: "/teams/default" },
        accounts: {
          support: {
            enabled: supportEnabled,
            appId: "support-app",
            appPassword: "support-secret",
            ...(supportPath ? { webhook: { path: supportPath } } : {}),
          },
        },
      });
      const accountIds = supportEnabled ? ["default", "support"] : ["default"];
      const controllers = accountIds.map(() => new AbortController());
      const tasks: Array<ReturnType<typeof runProvider>> = [];
      try {
        for (const [index, accountId] of accountIds.entries()) {
          routeState.ready = createDeferred<void>();
          tasks.push(runProvider(controllers[index]!, cfg, { accountId }));
          await Promise.race([routeState.ready.promise, tasks[index]]);
        }
        const supportRoute = {
          accountId: "support",
          path: supportPath ?? "/teams/default/support",
        };
        expect(routeState.routes.map(({ accountId, path }) => ({ accountId, path }))).toEqual([
          { accountId: "default", path: "/teams/default" },
          ...(defaultAlias ? [{ accountId: "default", path: "/api/messages" }] : []),
          ...(supportEnabled ? [supportRoute] : []),
        ]);
        // One route owner lets reload handoffs pass between alias and primary routes.
        expect(
          new Set(
            routeState.routes.map(({ pluginId, source, auth }) => `${pluginId}:${source}:${auth}`),
          ),
        ).toEqual(new Set(["msteams:msteams-webhook:plugin"]));
      } finally {
        controllers.forEach((controller) => controller.abort());
        await Promise.all(tasks);
      }
    },
  );
  it("forwards compatibility-listener /api/messages beside a named account on /api/messages", async () => {
    const cfg = configured({
      webhook: { path: "/teams/events" },
      legacyWebhook: { port: 44978, host: "127.0.0.1" },
      accounts: {
        support: {
          appId: "support-app",
          appPassword: "support-secret",
          webhook: { path: "/api/messages" },
        },
      },
    });
    const abort = new AbortController();
    const task = runProvider(abort, cfg);
    try {
      await Promise.race([routeState.ready.promise, task]);
      expect(routeState.routes.map(({ path }) => path)).toEqual(["/teams/events"]);
      // A compatibility listener hands unmatched paths to the primary route's handler.
      routeState.routes = [{ ...routeState.routes[0]!, path: "/api/messages" }];
      const response = await post();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ url: "/teams/events" });
    } finally {
      abort.abort();
      await task;
    }
  });
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
