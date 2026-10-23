import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { bridgeCodexAppServerStartOptions } from "./app-server/auth-bridge.js";
import { MAX_HOST_COUNT } from "./session-catalog-parsing.js";
import type { CodexSessionCatalogPage } from "./session-catalog-types.js";
import * as fixture from "./session-catalog.test-helpers.js";

const defaultPluginConfig = { supervision: { enabled: true } };
const createFactory = fixture.createCodexSessionCatalogControlFactory;
type ListOptions = Parameters<typeof fixture.listCodexSessionCatalog>[0];
const listCatalog = ({
  runtime = fixture.createRuntime().runtime,
  ...options
}: Omit<ListOptions, "config" | "runtime"> & Partial<Pick<ListOptions, "runtime">>) =>
  fixture.listCodexSessionCatalog({ config: fixture.config, runtime, ...options });
function registeredProvider(
  control: Parameters<typeof fixture.registerCodexSessionCatalog>[0]["control"],
  runtimeConfig = fixture.config,
) {
  return fixture.createCatalogTestProvider({
    startupConfig: runtimeConfig,
    control,
    getPluginConfig: () => defaultPluginConfig,
    getRuntimeConfig: () => runtimeConfig,
  });
}
type ManagedThreads = NonNullable<
  ReturnType<typeof fixture.createCodexTestBindingStore>["managedThreads"]
>;
function managedStore(snapshot: ManagedThreads["snapshot"], mark = vi.fn()) {
  return Object.assign(fixture.createCodexTestBindingStore(), {
    managedThreads: { has: vi.fn(async () => false), mark, snapshot },
  });
}
const explicitAgents = (
  entries: Record<string, { agentDir?: string }>,
): fixture.OpenClawConfig => ({
  agents: { ownership: "explicit", entries },
});
const homePath = (home: fixture.CodexCatalogHome, env = process.env) =>
  fixture.resolveCodexAppServerLocalHomeDir(home.appServer.start, home.agentDir, env);
const nativeThread = (id: string, fields: Partial<ReturnType<typeof fixture.idleThread>> = {}) => ({
  id,
  status: { type: "idle" as const },
  source: "cli",
  ...fields,
});
type Session = CodexSessionCatalogPage["sessions"][number];
const catalogSession = (threadId: string, fields: Partial<Session> = {}): Session => ({
  threadId,
  status: "idle",
  source: "cli",
  archived: false,
  ...fields,
});
function localHome(
  sourceHomeId: string,
  hostId = fixture.CODEX_LOCAL_SESSION_HOST_ID,
): fixture.CodexCatalogHome {
  return {
    sourceHomeId,
    hostId,
    label: sourceHomeId,
    agentDir: `/agents/${sourceHomeId}`,
    assertCurrent: vi.fn(),
    appServer: {} as fixture.CodexCatalogHome["appServer"],
    usesProcessHomeFallback: false,
  };
}
async function homeFixture(label: string) {
  const root = await fixture.fs.realpath(
    await fixture.fs.mkdtemp(
      fixture.path.join(fixture.os.tmpdir(), `openclaw-codex-catalog-${label}-`),
    ),
  );
  fixture.tempDirs.push(root);
  const alphaAgentDir = fixture.path.join(root, "agents", "alpha", "agent");
  const betaAgentDir = fixture.path.join(root, "agents", "beta", "agent");
  const processCodexHome = fixture.path.join(root, "process-codex-home");
  const alphaCodexHome = fixture.resolveCodexAppServerHomeDir(alphaAgentDir);
  const betaCodexHome = fixture.resolveCodexAppServerHomeDir(betaAgentDir);
  await Promise.all(
    [processCodexHome, alphaCodexHome, betaCodexHome].map((dir) =>
      fixture.fs.mkdir(dir, { recursive: true }),
    ),
  );
  const runtimeConfig = explicitAgents({
    alpha: { agentDir: alphaAgentDir },
    beta: { agentDir: betaAgentDir },
  });
  return {
    root,
    alphaAgentDir,
    betaAgentDir,
    processCodexHome,
    alphaCodexHome,
    betaCodexHome,
    runtimeConfig,
  };
}

it("waits for the registered provider's first page and then serves its resident host", async () => {
  const pending = createDeferred<{ data: ReturnType<typeof fixture.idleThread>[] }>();
  const started = createDeferred<void>();
  fixture.commandRpcMocks.codexControlRequest.mockImplementation(async () => {
    started.resolve();
    return pending.promise;
  });
  const factory = createFactory();
  const home = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", home);
  const provider = registeredProvider(factory);
  const query = { agentId: "main", hostIds: [home.hostId] };
  let delivered = false;
  const listed = provider.list(query).then((hosts) => {
    delivered = true;
    return hosts;
  });
  void listed.catch(() => undefined);
  try {
    await started.promise;
    expect(delivered).toBe(false);
    const initialized = control.initialize();
    pending.resolve({ data: [fixture.idleThread({ id: "hydrated-thread", source: "cli" })] });
    await initialized;
    expect(await listed).toMatchObject([
      { hostId: home.hostId, connected: true, sessions: [{ threadId: "hydrated-thread" }] },
    ]);
    expect(await provider.list(query)).toMatchObject([
      { hostId: home.hostId, sessions: [{ threadId: "hydrated-thread" }] },
    ]);
    expect(fixture.commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    expect(fixture.commandRpcMocks.codexControlRequest.mock.calls[0]?.[1]).toBe("thread/list");
  } finally {
    pending.resolve({ data: [] });
    await listed;
  }
});

it.each(["page", "snapshot"] as const)("stops work when retired during %s", async (phase) => {
  const released = createDeferred<void>();
  const started = createDeferred<void>();
  const pause = async () => {
    started.resolve();
    await released.promise;
  };
  const snapshot = vi.fn(async () => {
    if (phase === "snapshot") {
      await pause();
    }
    return new Map<string, ReadonlySet<string>>();
  });
  const listPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
    if (cursor) {
      return { sessions: [] };
    }
    await pause();
    return { sessions: [], managedThreads: [{ threadId: "managed" }], nextCursor: "next" };
  });
  const mark = vi.fn(async () => undefined);
  const controller = new AbortController();
  const reason = new Error(`catalog retired during ${phase}`);
  const options = {
    bindingStore: managedStore(snapshot, mark),
    control: fixture.createControl({ listPage }),
    query: { hostIds: [fixture.CODEX_LOCAL_SESSION_HOST_ID] },
    signal: controller.signal,
  };
  const listed = listCatalog({
    ...options,
    ...(phase === "page"
      ? { localHomes: [{ ...localHome("home-main"), label: "Main", agentDir: "/agents/main" }] }
      : { waitUntil: () => controller.signal.throwIfAborted() }),
  }).catch((error: unknown) => error);
  await started.promise;
  expect(snapshot).toHaveBeenCalledOnce();
  controller.abort(reason);
  released.resolve();
  const result = await listed;
  expect(mark).not.toHaveBeenCalled();
  expect(listPage).toHaveBeenCalledTimes(phase === "page" ? 1 : 0);
  if (phase === "snapshot") {
    expect(result).toBe(reason);
  } else {
    expect(result).toMatchObject({ hosts: [{ error: { code: "APP_SERVER_UNAVAILABLE" } }] });
  }
});

it("lists non-archived interactive threads without probing transcript previews", async () => {
  const pluginConfig = await fixture.normalizeCodexManifestConfig({
    supervision: { enabled: true },
    appServer: { command: "codex-catalog" },
  });
  expect((pluginConfig.appServer as Record<string, unknown>).homeScope).toBeUndefined();
  fixture.commandRpcMocks.codexControlRequest.mockResolvedValue({
    data: [
      nativeThread("thread-title", {
        name: "Match title",
        preview: "private\ntranscript preview",
        cwd: "/workspace/one",
        source: "vscode",
      }),
      nativeThread("thread-preview", { preview: "Unrelated private preview text" }),
      nativeThread("thread-fallback", {
        cwd: "/workspace/one",
        preview: "\x1b[31mMatch\x1b[0m\nvisible\x00 fallback\x7f title",
      }),
    ],
  });
  const control = createFactory({ getPluginConfig: () => pluginConfig }).forRequest("main");
  await control.initialize();

  await expect(
    control.listPage({ limit: 25, searchTerm: "mAtCh", cwd: " /workspace/one " }),
  ).resolves.toEqual({
    sessions: [
      catalogSession("thread-title", {
        name: "Match title",
        cwd: "/workspace/one",
        source: "vscode",
      }),
      catalogSession("thread-fallback", {
        cwd: "/workspace/one",
        fallbackName: "Match visible fallback title",
      }),
    ],
  });
  expect(fixture.commandRpcMocks.codexControlRequest).toHaveBeenCalledExactlyOnceWith(
    pluginConfig,
    "thread/list",
    {
      archived: false,
      limit: 16,
      modelProviders: [],
      sortKey: "recency_at",
      sortDirection: "desc",
    },
    expect.objectContaining({
      agentDir: fixture.resolveDefaultAgentDir(fixture.config),
      config: fixture.config,
      authProfileId: null,
      startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
    }),
  );
  expect(JSON.stringify(await control.listPage({ searchTerm: "mAtCh" }))).not.toContain("private");
  expect(
    fixture.commandRpcMocks.codexControlRequest.mock.calls.map((call) => call[1]),
  ).not.toContain("thread/resume");
});

it.each(["direct", "pinned"] as const)(
  "lists the primary native store through %s requests without importing its auth file",
  async (connectionKind) => {
    const agentDir = fixture.resolveDefaultAgentDir(fixture.config);
    const codexHome = fixture.resolveCodexAppServerHomeDir(agentDir);
    await fixture.fs.mkdir(codexHome, { recursive: true });
    await fixture.fs.writeFile(fixture.path.join(codexHome, "auth.json"), "{}");
    const prepareNativeRead = async (
      options: Omit<Parameters<typeof bridgeCodexAppServerStartOptions>[0], "authProfileStore">,
    ) => {
      const start = await bridgeCodexAppServerStartOptions({
        ...options,
        authProfileStore: { version: 1, profiles: {} },
      });
      expect(start.env?.CODEX_HOME).toBe(codexHome);
    };
    fixture.commandRpcMocks.codexControlRequest.mockImplementation(
      async (
        _pluginConfig: unknown,
        _method: string,
        _params: unknown,
        options: Parameters<typeof prepareNativeRead>[0],
      ) => {
        await prepareNativeRead(options);
        return { data: [] };
      },
    );
    fixture.pinnedConnectionMocks.getClient.mockImplementation(
      async (options: Parameters<typeof prepareNativeRead>[0]) => {
        await prepareNativeRead(options);
        return fixture.pinnedConnectionMocks.client;
      },
    );
    fixture.pinnedConnectionMocks.request.mockResolvedValue({ data: [] });
    const factory = createFactory({
      getPluginConfig: () => ({ appServer: { homeScope: "agent" } }),
    });
    const control = factory.forRequest("main", (await factory.homesForAgent("main"))[0]);
    if (connectionKind === "direct") {
      await control.initialize();
    }

    await expect(
      connectionKind === "pinned"
        ? control.withPinnedConnection(async (pinned) => {
            await pinned.initialize();
            return pinned.listPage({});
          })
        : control.listPage({}),
    ).resolves.toEqual({ sessions: [] });
    expect(await fixture.fs.readFile(fixture.path.join(codexHome, "auth.json"), "utf8")).toBe("{}");
  },
);

it("uses the Gateway-selected owner directory for an explicit multi-agent catalog", async () => {
  const runtimeConfig = explicitAgents({ alpha: {}, beta: {} });
  fixture.commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  const control = createFactory({
    getRuntimeConfig: () => runtimeConfig,
  }).forRequest("beta");
  await control.initialize();

  await expect(control.listPage({})).resolves.toEqual({ sessions: [] });

  expect(fixture.commandRpcMocks.codexControlRequest.mock.calls[0]?.[3]).toMatchObject({
    agentDir: fixture.resolveAgentDir(runtimeConfig, "beta"),
    config: runtimeConfig,
  });
});

it("discovers configured and automatic Codex homes while retaining the route owner", async () => {
  const { root, alphaAgentDir, betaAgentDir, processCodexHome, alphaCodexHome, betaCodexHome } =
    await homeFixture("homes");
  const fileAgentDir = fixture.path.join(root, "agents", "file", "agent");
  const fileAgentCodexHome = fixture.resolveCodexAppServerHomeDir(fileAgentDir);
  const configuredCodexHomes = Array.from({ length: MAX_HOST_COUNT }, (_, index) =>
    fixture.path.join(root, "configured-codex-home", String(index)),
  );
  const configuredCodexHome = configuredCodexHomes[0]!;
  const configuredCodexHomeAlias = fixture.path.join(root, "configured-codex-home-alias");
  const configuredFile = fixture.path.join(root, "not-a-codex-home");
  await Promise.all(configuredCodexHomes.map((dir) => fixture.fs.mkdir(dir, { recursive: true })));
  await Promise.all([
    fixture.fs.symlink(
      configuredCodexHome,
      configuredCodexHomeAlias,
      process.platform === "win32" ? "junction" : "dir",
    ),
    fixture.fs.writeFile(configuredFile, "not a directory"),
    fixture.fs
      .mkdir(fileAgentDir, { recursive: true })
      .then(() => fixture.fs.writeFile(fileAgentCodexHome, "not a directory")),
  ]);
  const runtimeConfig = explicitAgents({
    alpha: { agentDir: alphaAgentDir },
    beta: { agentDir: betaAgentDir },
    file: { agentDir: fileAgentDir },
  });
  const env = { ...process.env, CODEX_HOME: processCodexHome };

  const control = createFactory({
    config: runtimeConfig,
    env,
    getRuntimeConfig: () => runtimeConfig,
    getPluginConfig: () => ({
      supervision: { enabled: true },
      sessionCatalog: {
        homes: [
          configuredCodexHome,
          { path: configuredCodexHomeAlias, label: "Duplicate alias" },
          { path: configuredCodexHomes[1]!, label: "Named store" },
          { path: configuredCodexHomes[2]! },
          alphaCodexHome,
          fixture.path.join(root, "missing-codex-home"),
          configuredFile,
          ...configuredCodexHomes.slice(3),
        ],
      },
    }),
  });
  const homes = await control.homesForAgent("beta");

  const resolvedHomes = homes.map((home) => homePath(home, env));
  expect(homes).toHaveLength(MAX_HOST_COUNT);
  expect(resolvedHomes.slice(0, 3)).toEqual([processCodexHome, betaCodexHome, alphaCodexHome]);
  expect(resolvedHomes.filter((home) => configuredCodexHomes.includes(home))).toHaveLength(
    MAX_HOST_COUNT - 3,
  );
  expect(homes.slice(3, 6).map((home) => home.label)).toEqual([
    "Local Codex · 0",
    "Local Codex · Named store",
    "Local Codex · 2",
  ]);
  expect(homes.map((home) => home.agentDir)).toEqual(Array(MAX_HOST_COUNT).fill(betaAgentDir));
  expect(homes[0]?.hostId).toBe(fixture.CODEX_LOCAL_SESSION_HOST_ID);
  expect(homes.slice(1).every((home) => home.hostId.startsWith("gateway:local:"))).toBe(true);
  expect(new Set(homes.map((home) => home.sourceHomeId)).size).toBe(MAX_HOST_COUNT);
  expect(
    JSON.stringify(homes.map(({ hostId, sourceHomeId }) => ({ hostId, sourceHomeId }))),
  ).not.toContain(root);

  fixture.commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
  fixture.pinnedConnectionMocks.request.mockResolvedValue({
    thread: fixture.idleThread({ id: "thread-source" }),
  });
  const configuredSource = homes.find((home) => homePath(home, env) === configuredCodexHome);
  expect(configuredSource).toBeDefined();

  const configuredFingerprint = fixture.buildCodexAppServerConnectionFingerprint(
    configuredSource!.appServer,
    configuredSource!.agentDir,
  );
  const boundControl = await control.forUpstream("beta", configuredFingerprint);
  expect(boundControl).toBeDefined();
  expect(await control.forUpstream("beta", "unknown-fingerprint")).toBeUndefined();
  await boundControl!.initialize();
  await boundControl!.listPage({});
  await boundControl!.withPinnedConnection(
    async (pinned) => await pinned.readThread("thread-source", false),
  );

  for (const options of [
    fixture.commandRpcMocks.codexControlRequest.mock.calls[0]?.[3],
    fixture.pinnedConnectionMocks.getClient.mock.calls[0]?.[0],
  ]) {
    expect(options).toMatchObject({
      agentDir: betaAgentDir,
      startOptions: { env: { CODEX_HOME: configuredCodexHome } },
    });
  }
});

it("refreshes Codex homes once for each hot-reloaded config generation", async () => {
  const {
    alphaAgentDir,
    processCodexHome,
    betaCodexHome,
    runtimeConfig: configB,
  } = await homeFixture("reload");
  const configA = explicitAgents({ alpha: { agentDir: alphaAgentDir } });
  let runtimeConfig = configA;
  const stat = vi.spyOn(fixture.fs, "stat");
  try {
    const resolver = fixture.createCodexCatalogHomeResolver({
      config: configA,
      getRuntimeConfig: () => runtimeConfig,
      getPluginConfig: () => defaultPluginConfig,
      env: { ...process.env, CODEX_HOME: processCodexHome },
    });
    expect(stat).not.toHaveBeenCalled();
    expect(await resolver.forAgent("alpha")).not.toHaveLength(0);
    const seedDiscoveryCount = stat.mock.calls.length;
    expect(await resolver.forAgent("alpha")).not.toHaveLength(0);
    expect(stat).toHaveBeenCalledTimes(seedDiscoveryCount);

    runtimeConfig = configB;
    const betaHomes = await resolver.forAgent("beta");
    expect(betaHomes.some((home) => homePath(home) === betaCodexHome)).toBe(true);
    const reloadedDiscoveryCount = stat.mock.calls.length;

    const warmHomes = await resolver.forAgent("beta");
    expect(warmHomes).toHaveLength(betaHomes.length);
    for (const [index, home] of warmHomes.entries()) {
      expect(home).toEqual({ ...betaHomes[index], assertCurrent: expect.any(Function) });
    }
    expect(() => warmHomes[0]!.assertCurrent()).not.toThrow();
    expect(stat).toHaveBeenCalledTimes(reloadedDiscoveryCount);

    runtimeConfig = { ...configA };
    expect(() => warmHomes[0]!.assertCurrent()).toThrow("configuration changed");
    expect(await resolver.forAgent("beta")).toEqual([]);
    const remaining = await resolver.forAgent("alpha");
    expect(remaining.some((home) => home.appServer.start.env?.CODEX_HOME === betaCodexHome)).toBe(
      false,
    );
  } finally {
    stat.mockRestore();
  }
});

it.each(["list", "pin"] as const)(
  "rejects an obsolete source before a new %s operation captures configuration",
  async (operation) => {
    let runtimeConfig = fixture.config;
    const factory = createFactory({
      config: fixture.config,
      env: {
        CODEX_HOME: fixture.path.join(fixture.resolveDefaultAgentDir(fixture.config), "native"),
      },
      getRuntimeConfig: () => runtimeConfig,
    });
    const [source] = await factory.homesForAgent("main");
    assert(source, "Expected a local catalog source");
    const control = factory.forRequest("main", source);
    fixture.commandRpcMocks.codexControlRequest.mockResolvedValue({ data: [] });
    await control.initialize();
    await control.listPage({});
    runtimeConfig = { ...fixture.config };

    await expect(
      operation === "list"
        ? control.listPage({})
        : control.withPinnedConnection(async () => undefined),
    ).rejects.toThrow("configuration changed");
    expect(fixture.commandRpcMocks.codexControlRequest).toHaveBeenCalledOnce();
    expect(fixture.pinnedConnectionMocks.getClient).not.toHaveBeenCalled();

    const [current] = await factory.homesForAgent("main");
    const currentControl = factory.forRequest("main", current);
    await currentControl.initialize();
    await currentControl.listPage({});
    expect(fixture.commandRpcMocks.codexControlRequest).toHaveBeenCalledTimes(2);
  },
);

it("exposes every local source as an actionable host for the selected owner", async () => {
  const { betaAgentDir, processCodexHome, runtimeConfig } = await homeFixture("hosts");
  const listPage = vi.fn(async (source?: fixture.CodexCatalogHome) => ({
    sessions: [catalogSession(`thread-${source?.sourceHomeId ?? "missing"}`)],
  }));
  const forRequest = vi.fn((agentId: string, source?: fixture.CodexCatalogHome) =>
    fixture.createControl({ listPage: async () => await listPage(source) }),
  );
  const provider = registeredProvider({ forRequest }, runtimeConfig);

  await fixture.withEnvAsync({ CODEX_HOME: processCodexHome }, async () => {
    const onHost = vi.fn();
    const completions: Promise<void>[] = [];
    const hosts = await provider.list({
      agentId: "beta",
      listNodes: async () => ({ nodes: [] }),
      onHost,
      waitUntil: (completion) => {
        completions.push(completion);
      },
    });

    expect(hosts).toHaveLength(3);
    expect(completions).toHaveLength(3);
    await Promise.all(completions);
    expect(onHost).toHaveBeenCalledTimes(3);
    expect(onHost.mock.calls.map(([host]) => host)).toEqual(expect.arrayContaining(hosts));
    expect(hosts?.every((host) => host.hostId.startsWith("gateway:local"))).toBe(true);
    expect(
      hosts?.every(
        (host) =>
          host.sessions[0]?.sourceHomeId &&
          host.sessions[0]?.canContinue &&
          host.sessions[0]?.canArchive,
      ),
    ).toBe(true);
    expect(forRequest.mock.calls.every(([agentId]) => agentId === "beta")).toBe(true);
    expect(forRequest.mock.calls.every(([, source]) => source?.agentDir === betaAgentDir)).toBe(
      true,
    );
  });
});

it("does not project an adopted session onto another local home with the same thread id", async () => {
  const homeA = localHome("home-a");
  const homeB = localHome("home-b", `${fixture.CODEX_LOCAL_SESSION_HOST_ID}:home-b`);
  const sessionKey = fixture.supervisionSessionKey("thread-1", homeA.sourceHomeId);
  const sessionId = "openclaw-session-home-a";
  const { runtime } = fixture.createRuntime({
    entries: [
      {
        sessionKey,
        entry: fixture.adoptedEntry({
          sourceThreadId: "thread-1",
          sourceHomeId: "home-a",
          sessionId,
        }),
      },
    ],
  });
  const bindingStore = fixture.createCodexTestBindingStore();
  await fixture.seedSupervisionBinding({
    bindingStore,
    sessionId,
    sessionKey,
    sourceThreadId: "thread-1",
  });
  const result = await listCatalog({
    agentId: "main",
    bindingStore,
    runtime,
    control: fixture.createControl({
      listPage: async () => ({ sessions: [catalogSession("thread-1")] }),
    }),
    localHomes: [homeA, homeB],
    listNodes: async () => ({ nodes: [] }),
  });
  const sessions = new Map(result.hosts.map((host) => [host.hostId, host.sessions[0]]));

  expect(sessions.get(homeA.hostId)).toMatchObject({ sessionKey, sourceHomeId: "home-a" });
  expect(sessions.get(homeB.hostId)).toMatchObject({ sourceHomeId: "home-b" });
  expect(sessions.get(homeB.hostId)).not.toHaveProperty("sessionKey");
});

it("bulk-loads managed thread ids once and backfills visible catalog pages", async () => {
  const homeA = { ...localHome("home-a"), agentDir: "/agents/main" };
  const homeB = {
    ...localHome("home-b", `${fixture.CODEX_LOCAL_SESSION_HOST_ID}:home-b`),
    agentDir: "/agents/main",
  };
  const snapshot = vi.fn(
    async () => new Map<string, ReadonlySet<string>>([["home-a", new Set(["thread-managed"])]]),
  );
  const bindingStore = managedStore(snapshot);
  const listPage = vi.fn(async (params?: { cursor?: string; limit?: number }) =>
    params?.cursor === "next"
      ? { sessions: [catalogSession("thread-visible-2")] }
      : {
          sessions: [
            catalogSession("thread-managed", { source: "vscode" }),
            catalogSession("thread-visible-1"),
          ],
          nextCursor: "next",
        },
  );
  const result = await listCatalog({
    agentId: "main",
    bindingStore,
    control: fixture.createControl({ listPage }),
    query: { limitPerHost: 2 },
    localHomes: [homeA, homeB],
    listNodes: async () => ({ nodes: [] }),
  });

  expect(snapshot).toHaveBeenCalledOnce();
  expect(listPage).toHaveBeenCalledTimes(3);
  expect(result.hosts.map((host) => host.sessions.map((session) => session.threadId))).toEqual([
    ["thread-visible-1", "thread-visible-2"],
    ["thread-managed", "thread-visible-1"],
  ]);
});
