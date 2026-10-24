import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { cleanupTempDirs } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { startMcpLifecycleServer } from "./agent-bundle-mcp-lifecycle.test-support.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import {
  createMcpProbeFixture,
  probeMcpServer as probe,
} from "./agent-bundle-mcp-probe.test-support.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import type { McpOAuthIdentity } from "./mcp-oauth-identity.js";

const startAuthorization = vi.hoisted(() => vi.fn(async () => ({ status: "authorized" })));
const { unauthenticated, readAuthorization } = vi.hoisted(() => {
  const defaultStatuses = async (identities: readonly McpOAuthIdentity[]) =>
    identities.map(() => ({ state: "unauthenticated" }));
  return { unauthenticated: defaultStatuses, readAuthorization: vi.fn(defaultStatuses) };
});
vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: readAuthorization,
  startMcpOAuthAuthorization: startAuthorization,
}));

const tempDirs: string[] = [];
const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const releaseHeld: Array<() => void> = [];
let receipts: FixtureReceiptChannel;

function hold() {
  const started = createDeferred();
  const released = createDeferred();
  releaseHeld.push(() => released.resolve());
  return {
    started,
    released,
    wait: async () => {
      started.resolve();
      await released.promise;
    },
  };
}

function mcpConfig(servers: NonNullable<OpenClawConfig["mcp"]>["servers"]): OpenClawConfig {
  return { plugins: { enabled: false }, mcp: { servers } };
}

const oauthServer = () => ({
  transport: "streamable-http" as const,
  url: "https://mcp.example.test",
  auth: "oauth" as const,
  oauth: { identity: "per-requester" as const },
});

const enabledPlugin = () => ({ entries: { "reload-probe": { enabled: true } } });
function pluginRegistry(
  rootDir: string,
  mcpServers: Parameters<typeof createPluginManifestRecordFixture>[0]["mcpServers"],
) {
  return {
    plugins: [createPluginManifestRecordFixture({ id: "reload-probe", rootDir, mcpServers })],
  };
}

function waitForCall(marker: string, pending: Promise<unknown>, signal: AbortSignal) {
  return withinTest(
    awaitGateBeforeSettlement(
      receipts.waitFor(marker, "started"),
      pending,
      `Held MCP call settled before starting in ${marker}`,
    ),
    signal,
  );
}

function probeConnections(...runtimes: SessionMcpRuntime[]) {
  return Promise.all(
    runtimes.flatMap((runtime) => ["first", "second"].map((name) => probe(runtime, name))),
  );
}

async function expectToolsAndDispose(
  pending: ReturnType<typeof materializeBundleMcpToolsForRun>,
  names = ["healthy__probe"],
  retired = false,
) {
  const materialized = await pending;
  try {
    expect(materialized.tools.map((tool) => tool.name)).toEqual(names);
    if (retired) {
      expect(materialized.diagnostics).toEqual([
        expect.objectContaining({
          serverName: "changed",
          message: expect.stringMatching(/retired/),
        }),
      ]);
    }
  } finally {
    await materialized.dispose();
  }
}

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});

afterAll(async () => {
  await receipts.close();
});

afterEach(async () => {
  for (const release of releaseHeld.splice(0)) {
    release();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  cleanupTempDirs(tempDirs);
  startAuthorization.mockClear();
  readAuthorization.mockReset().mockImplementation(unauthenticated);
});

async function fixture(
  scheduler = createTestGatewayScheduler(),
  createRuntime?: CreateSessionMcpRuntime,
) {
  const { params, config } = await createMcpProbeFixture(tempDirs, receipts.endpoint);
  const manager = createSessionMcpRuntimeManager({ scheduler, createRuntime });
  const { manifestRegistry } = params;
  managers.push(manager);
  return {
    params,
    config,
    manager,
    get: (cfg = config()) => manager.getOrCreate({ ...params, cfg }),
    publish: (cfg: OpenClawConfig, reloadPlugins = false) =>
      manager.reloadConfig({ cfg, manifestRegistry, reloadPlugins }),
  };
}

it("keeps unchanged server transports and catalogs when another server changes", async () => {
  const { config, get } = await fixture();
  const original = await get();
  const originalCatalog = await original.getCatalog();
  const first = await probe(original, "healthy");
  const old = await probe(original, "changed");
  const refreshed = await get(config("new"));

  expect(await probe(refreshed, "healthy")).toEqual(first);
  expect(await probe(original, "healthy")).toEqual(first);
  expect((await refreshed.getCatalog()).servers.healthy).toBe(originalCatalog.servers.healthy);
  expect(await probe(refreshed, "changed")).toMatchObject({ label: "new" });
  expect((await probe(refreshed, "changed")).pid).not.toBe(old.pid);
  await expect(probe(original, "changed")).rejects.toThrow(/disposed|retir/);
});

it("revokes only the changed owner immediately on collision publication", async () => {
  const { manager, config, params, get, publish } = await fixture();
  const acquisition = await manager.acquire({ ...params, cfg: config() });
  const original = acquisition.runtime;
  const healthy = await probe(original, "healthy");
  await probe(original, "changed");
  const next = config("new");
  next.mcp!.servers = {
    CHANGED: expectDefined(config().mcp!.servers!.changed, "collision source server"),
    ...config().mcp!.servers,
  };
  await publish(next);
  await expect(probe(original, "changed")).rejects.toThrow();
  expect(await probe(original, "healthy")).toEqual(healthy);
  await expectToolsAndDispose(materializeBundleMcpToolsForRun(acquisition), undefined, true);
  const refreshed = await get(next);
  expect(await probe(refreshed, "healthy")).toEqual(healthy);
  const catalog = await refreshed.getCatalog();
  expect(catalog.servers.changed?.safeServerName).toBe("changed-2");
});

it("allows an unchanged server call to finish across config publication", async ({ signal }) => {
  const { config, params, get, publish } = await fixture();
  const original = await get();
  const healthy = await probe(original, "healthy");
  const held = path.join(params.workspaceDir, "held-call");
  const result = probe(original, "healthy", { hold: held });
  const observed = result.catch(() => undefined);
  try {
    await waitForCall(held, result, signal);
    await publish(config("new"));
    const refreshed = await get(config("new"));
    await fs.writeFile(held, "release");
    expect(await result).toEqual(healthy);
    expect(await probe(refreshed, "healthy")).toEqual(healthy);
  } finally {
    await fs.writeFile(held, "release");
    await observed;
  }
});

it.each(["creating", "queued"])(
  "fences a %s acquisition against a crossed publication",
  async (phase) => {
    const { started, released, wait } = hold();
    const { config, params, manager, get, publish } = await fixture(undefined, async (input) => {
      await wait();
      return createSessionMcpRuntime(input);
    });
    const first = manager.acquire({ ...params, cfg: config() });
    await started.promise;
    const pending = phase === "queued" ? manager.acquire({ ...params, cfg: config() }) : first;
    const next = config();
    delete next.mcp!.servers!.changed;
    await publish(next);
    released.resolve();
    if (phase === "queued") {
      (await first).releaseLease();
    }
    const acquisition = await pending;
    const old = acquisition.runtime;
    await expect(probe(old, "changed")).rejects.toThrow();
    expect(await probe(old, "healthy")).toMatchObject({ label: "healthy" });
    await expectToolsAndDispose(materializeBundleMcpToolsForRun(acquisition));
    const current = await get(next);
    expect((await current.getCatalog()).servers.changed).toBeUndefined();
  },
);

async function httpProbe(onDelete?: () => Promise<void>, onList?: () => Promise<void>) {
  const server = await startMcpLifecycleServer({
    toolName: "probe",
    onDelete,
    onList,
    text: (_endpoint, pid) => JSON.stringify({ pid, label: "requester" }),
  });
  cleanups.push(server.close);
  return `${server.url}/mcp`;
}

it.each(["changed", "healthy"])(
  "materializes healthy siblings when %s discovery spans revocation",
  async (heldServer) => {
    const { started, released, wait } = hold();
    const url = await httpProbe(undefined, wait);
    const { manager, config, params, publish } = await fixture();
    const cfg = config();
    cfg.mcp!.servers![heldServer] = { transport: "streamable-http", url };
    const acquisition = await manager.acquire({ ...params, cfg });
    const pending = materializeBundleMcpToolsForRun(acquisition);
    void pending.catch(() => undefined);
    await started.promise;
    await probe(acquisition.runtime, heldServer === "changed" ? "healthy" : "changed");
    const next = structuredClone(cfg);
    delete next.mcp!.servers!.changed;
    await publish(next);
    released.resolve();
    await expectToolsAndDispose(pending, undefined, true);
  },
);

it.each(["remove", "public origin"])(
  "does not publish revoked sign-in tools when %s crosses sibling discovery",
  async (change) => {
    const { started, released, wait } = hold();
    const url = await httpProbe(undefined, wait);
    const { manager, config, params, publish } = await fixture();
    const cfg = config();
    cfg.gateway = { publicOrigin: "https://gateway.example.test" };
    cfg.mcp!.servers!.healthy = { transport: "streamable-http", url };
    for (const serverName of ["calendar", "contacts"]) {
      cfg.mcp!.servers![serverName] = {
        ...oauthServer(),
        url: `https://mcp.example.test/${serverName}`,
      };
    }
    const acquisition = await manager.acquire({ ...params, cfg, requesterSenderId: "alice" });
    const pending = materializeBundleMcpToolsForRun(acquisition);
    await started.promise;
    const next = structuredClone(cfg);
    if (change === "remove") {
      delete next.mcp!.servers!.calendar;
    } else {
      next.gateway!.publicOrigin = "https://replacement.example.test";
    }
    await publish(next);
    released.resolve();
    await expectToolsAndDispose(
      pending,
      change === "public origin"
        ? ["changed__probe", "healthy__probe"]
        : ["changed__probe", "contacts__connect", "healthy__probe"],
    );
  },
);

it("rotates one requester's changed server while retaining sibling connections and requesters", async () => {
  const resolverRegistry = createMcpProofPluginRegistry();
  await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    const url = await httpProbe();
    let generation = 0;

    const resolverApi = resolverRegistry.apiFor("test-plugin");
    for (const serverName of ["first", "second"]) {
      resolverApi.registerMcpServerConnectionResolver({
        serverName,
        resolve: async ({ requesterSenderId }) => ({
          url,
          headers: {
            Authorization: `proof-${requesterSenderId}-${serverName === "first" && requesterSenderId === "alice" ? generation : 0}`,
          },
        }),
      });
    }
    const clock = createGatewaySchedulerClock(100_000);
    const { manager, params, publish } = await fixture(createTestGatewayScheduler(clock.clock));
    const cfg = mcpConfig({
      first: { transport: "streamable-http" },
      second: { transport: "streamable-http" },
    });
    const aliceParams = { ...params, cfg, requesterSenderId: "alice" };
    const bobParams = { ...params, cfg, requesterSenderId: "bob" };
    const alice = await manager.getOrCreate(aliceParams);
    const bob = await manager.getOrCreate(bobParams);
    const before = await probeConnections(alice, bob);
    generation++;
    clock.setTime(clock.clock.now() + 300_000);
    const nextAlice = await manager.getOrCreate(aliceParams);
    const nextBob = await manager.getOrCreate(bobParams);
    const after = await probeConnections(nextAlice, nextBob);
    expect(after[0]).not.toEqual(before[0]);
    expect(after.slice(1)).toEqual(before.slice(1));
    await publish(cfg, true);
    await expect(probe(nextAlice, "first")).rejects.toThrow();
    const successor = await manager.getOrCreate(aliceParams);
    expect(await probe(successor, "first")).not.toEqual(after[0]);
  });
});

it.each(["removal", "public origin change", "plugin replacement with explicit shadow"])(
  "revokes a retained connect callback on %s",
  async (change) => {
    const { manager, params } = await fixture();
    const cfg: OpenClawConfig = {
      ...mcpConfig({ calendar: { ...oauthServer(), cwd: params.workspaceDir } }),
      gateway: { publicOrigin: "https://gateway.example.test" },
    };
    const calendar = expectDefined(cfg.mcp!.servers!.calendar, "calendar server");
    const reloadPlugins = change === "plugin replacement with explicit shadow";
    const manifestRegistry = reloadPlugins
      ? pluginRegistry(params.workspaceDir, { calendar })
      : params.manifestRegistry;
    if (reloadPlugins) {
      cfg.plugins = enabledPlugin();
      cfg.mcp!.servers = {};
    }
    const runtime = await manager.getOrCreate({
      ...params,
      manifestRegistry,
      cfg,
      requesterSenderId: "alice",
    });
    const connect = runtime.requesterConnect?.createExecute("calendar");
    expect(connect).toBeDefined();
    await connect!("before", {});
    expect(startAuthorization).toHaveBeenCalledOnce();
    await manager.reloadConfig({
      cfg:
        change === "removal"
          ? { ...cfg, mcp: { servers: {} } }
          : reloadPlugins
            ? { ...cfg, mcp: { servers: { calendar } } }
            : {
                ...cfg,
                gateway: { publicOrigin: "https://replacement.example.test" },
              },
      manifestRegistry,
      reloadPlugins,
    });
    await expect(connect!("after", {})).rejects.toThrow("disposed");
    expect(startAuthorization).toHaveBeenCalledOnce();
  },
);

it("retires an in-flight plugin across publication and reconnects on the next acquisition", async () => {
  const resolverRegistry = createMcpProofPluginRegistry();
  await withPluginRuntimeRegistryScope(resolverRegistry.registry, async () => {
    const url = await httpProbe();
    const cfg = mcpConfig({ scoped: { transport: "streamable-http" } });
    const resolverApi = resolverRegistry.apiFor("test-plugin");
    resolverApi.registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url }),
    });
    const { started, released, wait } = hold();
    let retired: SessionMcpRuntime | undefined;
    let firstConnection: Awaited<ReturnType<typeof probe>> | undefined;
    const { manager, params, publish } = await fixture(undefined, async (input) => {
      const runtime = createSessionMcpRuntime(input);
      if (input.requesterScope && !retired) {
        retired = runtime;
        firstConnection = await probe(runtime, "scoped");
        await wait();
      }
      return runtime;
    });
    const pending = manager.getOrCreate({ ...params, cfg, requesterSenderId: "alice" });
    await started.promise;
    resolverApi.registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url, headers: { Authorization: "replacement" } }),
    });
    await publish(cfg, true);
    await publish(structuredClone(cfg));
    released.resolve();
    await expect(probe(await pending, "scoped")).rejects.toThrow("disposed");
    await expect(probe(expectDefined(retired, "retired plugin owner"), "scoped")).rejects.toThrow();
    const next = await manager.getOrCreate({ ...params, cfg, requesterSenderId: "alice" });
    expect(await probe(next, "scoped")).not.toEqual(firstConnection);
  });
});

it.each(["shadow at publication", "shadow before transfer"])(
  "retires a transferred plugin with %s before the next queued acquisition",
  async (shadow) => {
    const { manager, config, params } = await fixture();
    const bundledServer = {
      command: process.execPath,
      args: [path.join(params.workspaceDir, "server.mjs"), "plugin"],
      cwd: params.workspaceDir,
    };
    const manifestRegistry = pluginRegistry(params.workspaceDir, { bundled: bundledServer });
    const cfg = (label: string): OpenClawConfig => {
      const next = {
        ...config(label),
        plugins: enabledPlugin(),
      };
      if (label === "winner" || (label === "intermediate" && shadow === "shadow before transfer")) {
        next.mcp!.servers!.bundled = bundledServer;
      }
      return next;
    };
    const acquire = (label: string) =>
      manager.getOrCreate({ ...params, manifestRegistry, cfg: cfg(label) });
    const original = await acquire("old");
    const healthy = await probe(original, "healthy");
    const bundled = await probe(original, "bundled");
    const { started: closing, released, wait } = hold();
    const dispose = original.dispose;
    original.dispose = async () => {
      await wait();
      await dispose();
    };
    const first = acquire("intermediate");
    await closing.promise;
    await manager.reloadConfig({ cfg: cfg("winner"), manifestRegistry, reloadPlugins: true });
    const second = acquire("winner");
    released.resolve();
    await first;
    const winner = await second;
    expect(await probe(winner, "healthy")).toEqual(healthy);
    expect((await probe(winner, "bundled")).pid).not.toBe(bundled.pid);
  },
);

it("reconciles a second publication arriving while a pending owner is retiring a server", async () => {
  const { started: closing, released: releaseClose, wait } = hold();
  let held = false;
  const url = await httpProbe(async () => {
    if (!held) {
      held = true;
      await wait();
    }
  });
  const server = { transport: "streamable-http" as const, url };
  const cfg = mcpConfig({ first: server, second: server });
  const { started: created, released: releaseCreate, wait: waitForCreate } = hold();
  const { get, publish } = await fixture(undefined, async (input) => {
    const runtime = createSessionMcpRuntime(input);
    await runtime.getCatalog();
    await waitForCreate();
    return runtime;
  });
  const pending = get(cfg);
  await created.promise;
  await publish(mcpConfig({ second: server }));
  releaseCreate.resolve();
  await closing.promise;
  const latestPublication = publish(mcpConfig({}));
  releaseClose.resolve();
  await latestPublication;
  await expect(probe(await pending, "second")).rejects.toThrow();
});

it("accounts for config cleanup with concurrent replacement", async () => {
  const { started: closing, released: releaseClose, wait } = hold();
  const url = await httpProbe(wait);
  const { manager, params, get, publish } = await fixture();
  const server = { transport: "streamable-http" as const, url };
  const next = mcpConfig({ second: server });
  const original = await get(mcpConfig({ first: server }));
  await probe(original, "first");
  const acquire = (sessionId: string) =>
    manager.getOrCreate({
      ...params,
      sessionId,
      cfg: next,
    });
  const leases = [];
  try {
    for (let index = 0; index < 255; index += 1) {
      leases.push(
        await manager.acquire({
          ...params,
          sessionId: `other-${index}`,
          cfg: next,
        }),
      );
    }
    const reload = publish(next);
    await closing.promise;
    const replacement = acquire(params.sessionId);
    const blocked = await acquire("overflow");
    expect((await blocked.getCatalog()).diagnostics?.[0]?.message).toContain(
      "all 256 Gateway MCP runtimes are in use",
    );
    expect(manager.peekSession({ sessionId: "overflow" })).toBeUndefined();
    releaseClose.resolve();
    await reload;
    const replaced = await replacement;
    await acquire("overflow");
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    await manager.disposeSession("overflow");
    expect(await acquire(params.sessionId)).not.toBe(replaced);
  } finally {
    releaseClose.resolve();
    leases.forEach((lease) => lease.releaseLease());
  }
});

it("joins config retirement cleanup before installing a replacement transport", async () => {
  const { started: closing, released: releaseClose, wait } = hold();
  const url = await httpProbe(wait);
  const { get, publish } = await fixture();
  const server = { transport: "streamable-http" as const, url };
  const cfg = mcpConfig({ first: server, second: server });
  const original = await get(cfg);
  await probe(original, "first");
  const healthy = await probe(original, "second");
  const next = {
    ...cfg,
    mcp: { servers: { first: { ...server, headers: { "X-Generation": "new" } }, second: server } },
  };
  const reload = publish(next);
  await closing.promise;
  let installed = false;
  const replacement = get(next).then((runtime) => {
    installed = true;
    return runtime;
  });
  // Let ready producers drain while the server deliberately holds DELETE open.
  await setImmediate();
  expect(installed).toBe(false);
  releaseClose.resolve();
  await reload;
  expect(await probe(await replacement, "second")).toEqual(healthy);
  expect(await probe(await replacement, "first")).not.toEqual(healthy);
});

it("revokes transferred active work while unrelated transport cleanup is pending", async ({
  signal,
}) => {
  const { started: closing, released: releaseClose, wait } = hold();
  const url = await httpProbe(wait);
  const { config, params, get, publish } = await fixture();
  const cfg = config();
  cfg.mcp!.servers!.changed = { transport: "streamable-http", url };
  const original = await get(cfg);
  await probe(original, "changed");
  const marker = path.join(params.workspaceDir, "revoked-call");
  let revoked = false;
  const held = probe(original, "healthy", { hold: marker }).catch(() => {
    revoked = true;
  });
  await waitForCall(marker, held, signal);
  const next = structuredClone(cfg);
  next.mcp!.servers!.changed = { transport: "streamable-http", url, headers: { generation: "2" } };
  const pending = get(next);
  void pending.catch(() => undefined);
  await closing.promise;
  const removed = structuredClone(next);
  delete removed.mcp!.servers!.healthy;
  await publish(removed);
  await setImmediate();
  expect(revoked).toBe(true);
  releaseClose.resolve();
  await pending;
  await held;
});

it("completes required retirement when the old run releases the final transferred lease", async () => {
  const { manager, config, params, get } = await fixture();
  const original = await get();
  const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
  const healthy = await probe(original, "healthy");
  manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
  const replacement = await get(config("new"));
  const releaseReplacement = expectDefined(replacement.acquireLease, "replacement run lease")();
  releaseReplacement();
  await expect(manager.completeDeferredRetirement(params.sessionId, replacement)).resolves.toBe(
    false,
  );
  releaseOriginal();
  await expect(manager.completeDeferredRetirement(params.sessionId, original)).resolves.toBe(true);
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});

it.each([false, true])(
  "defers retirement behind acquisition (required: %s)",
  async (retainAcrossReuse) => {
    const { manager, config, params, get } = await fixture();
    const original = await get();
    const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
    const healthy = await probe(original, "healthy");
    const { started: closing, released: releaseClose, wait } = hold();
    const dispose = original.dispose;
    original.dispose = async () => {
      await wait();
      await dispose();
    };
    const pending = manager.acquire({ ...params, cfg: config("new") }).then((lease) => ({
      runtime: lease.runtime,
      release: lease.releaseLease,
    }));
    await closing.promise;
    manager.deferRetirement(params.sessionId, { retainAcrossReuse });
    releaseOriginal();
    const retiring = manager.completeDeferredRetirement(params.sessionId, original);
    releaseClose.resolve();
    const next = await pending;
    await expect(retiring).resolves.toBe(false);
    expect(await probe(next.runtime, "healthy")).toEqual(healthy);
    next.release();
    await expect(manager.completeDeferredRetirement(params.sessionId, next.runtime)).resolves.toBe(
      retainAcrossReuse,
    );
  },
);

it("completes required retirement after pending requester acquisition fails without a lease", async () => {
  const { manager, config, params } = await fixture();
  const cfg = config();
  cfg.mcp!.servers!.calendar = oauthServer();
  const input = { ...params, cfg, requesterSenderId: "alice" };
  const original = await manager.getOrCreate(input);
  const releaseOriginal = expectDefined(original.acquireLease, "original run lease")();
  const healthy = await probe(original, "healthy");
  const { started, released, wait } = hold();
  readAuthorization.mockImplementationOnce(async () => {
    await wait();
    throw new Error("requester authorization unavailable");
  });
  const pending = manager.getOrCreateRequesterScoped(input).catch((error: unknown) => error);
  await started.promise;
  manager.deferRetirement(params.sessionId, { retainAcrossReuse: true });
  releaseOriginal();
  const retiring = manager.completeDeferredRetirement(params.sessionId, original);
  released.resolve();
  expect(await pending).toMatchObject({ message: "requester authorization unavailable" });
  await expect(retiring).resolves.toBe(true);
  expect(manager.listRuntimeKeys()).toEqual([]);
  expect(() => process.kill(healthy.pid, 0)).toThrow();
});
