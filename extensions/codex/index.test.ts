import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveProviderIdForAuth } from "openclaw/plugin-sdk/provider-auth-aliases";
import {
  closeOpenClawStateDatabaseAsync,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";
import {
  CODEX_MANAGED_THREAD_NAMESPACE,
  CODEX_MANAGED_THREAD_MAX_ENTRIES,
  type StoredCodexManagedThread,
} from "./src/app-server/managed-thread-store.js";
import {
  codexPluginConfig,
  curatedPlugin,
} from "./src/app-server/plugin-inventory.test-helpers.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
} from "./src/app-server/session-binding.js";
import {
  createCodexTestBindingStateStore,
  testCodexAppServerBindingStore,
} from "./src/app-server/session-binding.test-helpers.js";
import { createCodexSessionCatalogNodeHostCommands } from "./src/session-catalog-listing.js";
import type { CodexSessionCatalogControl } from "./src/session-catalog-types.js";
import { CODEX_SUPERVISION_COMPAT_TOOL_NAMES } from "./src/supervision-tools.js";
import { registeredCodexTools } from "./src/tool-registration.test-support.js";

const runCodexAppServerAttemptMock = vi.hoisted(() => vi.fn());
const runCodexAppServerSideQuestionMock = vi.hoisted(() => vi.fn());
const explicitAgentConfig = {
  agents: {
    ownership: "explicit",
    entries: { main: {}, clawblocker: {}, blockdigest: {} },
  },
} as OpenClawConfig;

const modelAuth = {
  ensureAuthProfileStore,
  ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder,
  resolveProviderIdForAuth,
};

function createCodexTestRuntime(
  current: () => unknown = () => ({}),
  stateStore = createCodexTestBindingStateStore(),
) {
  return {
    modelAuth,
    config: { current },
    state: {
      openSyncKeyedStore: () => stateStore,
      openKeyedStoreV2: (
        _options: unknown,
        authority?: Parameters<typeof stateStore.withCurrent>[0],
      ) => ({
        ...stateStore.asyncReads,
        ...stateStore.withCurrent(authority ?? { assertCurrent() {} }),
      }),
    },
  } as never;
}

vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: runCodexAppServerAttemptMock,
}));
vi.mock("./src/app-server/side-question.js", () => ({
  runCodexAppServerSideQuestion: runCodexAppServerSideQuestionMock,
}));

function createCodexTestApi(overrides: Parameters<typeof createTestPluginApi>[0] = {}) {
  const config = overrides.config ?? {
    plugins: { entries: { codex: { config: overrides.pluginConfig } } },
  };
  return createTestPluginApi({
    id: "codex",
    name: "Codex",
    source: "test",
    config,
    pluginConfig: {},
    ...overrides,
    runtime: overrides.runtime ?? createCodexTestRuntime(() => config),
  });
}

function registerPlugin(overrides: Parameters<typeof createTestPluginApi>[0] = {}) {
  const registrations = {
    registerAgentHarness: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerNodeHostCommand: vi.fn(),
    registerNodeInvokePolicy: vi.fn(),
    registerProvider: vi.fn(),
    registerSessionCatalog: vi.fn(),
    registerTool: vi.fn<OpenClawPluginApi["registerTool"]>(),
  };
  plugin.register(createCodexTestApi({ ...registrations, ...overrides }));
  return registrations;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mock.mock.calls.at(index)?.at(argIndex);
}

function pluginEntry(config: unknown, enabled?: boolean) {
  return {
    plugins: { entries: { codex: { config, ...(enabled === undefined ? {} : { enabled }) } } },
  };
}

describe("codex plugin", () => {
  it("persists managed exclusions through the registered harness and catalog without parent SQLite", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-managed-worker-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const options = {
      namespace: CODEX_MANAGED_THREAD_NAMESPACE,
      maxEntries: CODEX_MANAGED_THREAD_MAX_ENTRIES,
      overflowPolicy: "evict-oldest" as const,
      env,
    };
    const native = createPluginStateSyncKeyedStoreForTests<StoredCodexManagedThread>(
      "codex",
      options,
    );
    const original = {
      version: 1 as const,
      kind: "managed-thread" as const,
      sourceHomeId: "home",
      threadId: "managed",
      rolloutPath: "/first.jsonl",
    };
    const runtime = createPluginRuntimeMock();
    runtime.state.openKeyedStoreV2 = <T>(
      storeOptions: Parameters<typeof runtime.state.openKeyedStoreV2>[0],
      authority?: Parameters<typeof runtime.state.openKeyedStoreV2>[1],
    ) =>
      createPluginStateKeyedStoreForTests<T>("codex", { ...storeOptions, env }).withCurrent(
        authority ?? { assertCurrent() {} },
      );
    runtime.state.openSyncKeyedStore = <T>(
      storeOptions: Parameters<typeof runtime.state.openSyncKeyedStore>[0],
    ) => createPluginStateSyncKeyedStoreForTests<T>("codex", { ...storeOptions, env });
    vi.spyOn(runtime.state, "openKeyedStoreV2");
    vi.spyOn(runtime.state, "openSyncKeyedStore");
    const registerAgentHarness = vi.fn();
    const observation = observeHostDataSql();
    const sql = observation.calls;
    try {
      plugin.register(createTestPluginApi({ id: "codex", runtime, registerAgentHarness }));
      expect(runtime.state.openKeyedStoreV2).not.toHaveBeenCalled();
      expect(runtime.state.openSyncKeyedStore).not.toHaveBeenCalled();
      const harness = mockCallArg(registerAgentHarness) as ReturnType<
        typeof createCodexAppServerAgentHarness
      >;
      runCodexAppServerAttemptMock.mockResolvedValueOnce({ terminal: { kind: "ok" } });
      await harness.runAttempt({ prompt: "synthetic catalog proof" } as never);
      const { bindingStore } = mockCallArg(runCodexAppServerAttemptMock, -1, 1) as {
        bindingStore: CodexAppServerBindingStore;
      };
      const managed = bindingStore.managedThreads!;
      await managed.mark(original);
      await expect(managed.mark({ ...original, rolloutPath: "/later.jsonl" })).resolves.toBe(true);
      await expect(managed.has("home", "managed")).resolves.toBe(true);
      const control: CodexSessionCatalogControl = {
        initialize: async () => {},
        listPage: async () => ({
          sessions: [
            { threadId: "managed", status: "idle", archived: false },
            { threadId: "native", status: "idle", archived: false },
          ],
          managedThreads: [{ threadId: "backfilled" }],
        }),
        withPinnedConnection: async (run) => run(control),
        requireEligibleThread: vi.fn(),
        listDescendantPage: vi.fn(),
        listTurnPage: vi.fn(),
        listItemPage: vi.fn(),
        forkThread: vi.fn(),
        readThread: vi.fn(),
        archiveThread: vi.fn(),
      };
      const command = createCodexSessionCatalogNodeHostCommands(
        {
          hasActiveWork: () => false,
          disconnect: async () => {},
          forRequest: () => control,
          forNode: async () => ({
            control,
            sourceHomeId: "home",
            codexHome: "/synthetic",
            transport: "stdio",
            assertCurrent: () => {},
          }),
          homesForAgent: async () => [],
          forUpstream: async () => undefined,
        },
        bindingStore,
      ).find((candidate) => candidate.command === "codex.appServer.threads.list.v1")!;
      const page = JSON.parse(await command.handle(JSON.stringify({ limit: 2 })));
      expect(page.sessions.map((entry: { threadId: string }) => entry.threadId)).toEqual([
        "native",
      ]);
      await expect(managed.has("home", "backfilled")).resolves.toBe(true);
      for (const operation of sql) {
        expect(operation).not.toHaveBeenCalled();
      }
      expect(runtime.state.openKeyedStoreV2).toHaveBeenCalledExactlyOnceWith({
        namespace: CODEX_MANAGED_THREAD_NAMESPACE,
        maxEntries: 20_000,
        overflowPolicy: "evict-oldest",
      });
      expect(runtime.state.openSyncKeyedStore).not.toHaveBeenCalled();
      // The retained sync adapter observes the same rows and preserves the first writer.
      const rows = native.entries();
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.value.threadId === "managed")).toMatchObject({
        key: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        value: original,
      });
      expect(rows.every((row) => row.expiresAt === undefined)).toBe(true);
      await closeOpenClawStateDatabaseAsync();
      await expect(
        createPluginStateKeyedStoreForTests<StoredCodexManagedThread>("codex", options).entries(),
      ).resolves.toEqual(rows);
    } finally {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each([true, false])("registers request-scoped surfaces with catalog enabled=%s", (enabled) => {
    const registration = registerPlugin({
      config: explicitAgentConfig,
      ...(!enabled ? { pluginConfig: { sessionCatalog: { enabled: false } } } : {}),
    });
    const {
      registerAgentHarness,
      registerGatewayMethod,
      registerNodeHostCommand,
      registerNodeInvokePolicy,
      registerProvider,
      registerSessionCatalog,
    } = registration;
    expect(registerAgentHarness).toHaveBeenCalledOnce();
    expect(registerGatewayMethod).toHaveBeenCalledWith("codex.accountUsage", expect.any(Function), {
      scope: "operator.admin",
    });
    expect(registerSessionCatalog).toHaveBeenCalledTimes(Number(enabled));
    expect(registerProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "codex",
        auth: [],
        prepareSyntheticAuth: expect.any(Function),
      }),
    );
    const commands = registerNodeHostCommand.mock.calls.map(([command]) => command);
    const names = commands.map(({ command }) => command);
    if (enabled) {
      expect(names).toEqual(
        expect.arrayContaining([
          "codex.appServer.threads.list.v1",
          "codex.appServer.thread.turns.list.v1",
          "codex.terminal.resume.v1",
          "codex.exec-server.stdio.v1",
        ]),
      );
    } else {
      expect(names).toEqual([
        "codex.cli.sessions.list",
        "codex.cli.session.resume",
        "codex.exec-server.stdio.v1",
      ]);
    }
    expect(commands.find(({ command }) => command === "codex.exec-server.stdio.v1")).toMatchObject({
      cap: "codex.exec-server",
      dangerous: true,
      duplex: true,
    });
    const nodeExecServerPolicy = registerNodeInvokePolicy.mock.calls
      .map(([policy]) => policy)
      .find((policy) => policy.commands.includes("codex.exec-server.stdio.v1"));
    expect(nodeExecServerPolicy).toMatchObject({
      commands: ["codex.exec-server.stdio.v1"],
      dangerous: true,
    });
    expect(nodeExecServerPolicy?.defaultPlatforms).toBeUndefined();
  });

  it("declares native tools before workspace readiness across owner and completion turns", async () => {
    const { registerTool } = registerPlugin({
      pluginConfig: { appServer: { homeScope: "user" }, supervision: { enabled: true } },
    });

    const registration = registeredCodexTools(registerTool);
    expect(registration.options).toEqual({
      names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES],
      workspaceAccess: "execute",
    });
    expect(registration.create({ senderIsOwner: true }).map((tool) => tool.name)).toEqual([
      ...CODEX_SUPERVISION_COMPAT_TOOL_NAMES,
    ]);
    for (const registered of [
      registration,
      registeredCodexTools(registerTool, "codex_plugins"),
      registeredCodexTools(registerTool, "codex_threads"),
    ]) {
      expect(registered.options?.workspaceAccess).toBe("execute");
      expect(() =>
        registered.factory.create({
          senderIsOwner: true,
          assertInvocationCurrent() {},
          get workspaceDir(): string {
            throw new Error("Tool declaration must not inspect the pending workspace");
          },
        }),
      ).not.toThrow();
      const declaration = (owner?: boolean) =>
        registered.create({ senderIsOwner: owner }).map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }));
      const ownerDeclaration = declaration(true);
      expect(ownerDeclaration).not.toEqual([]);
      expect(declaration(false)).toEqual(ownerDeclaration);
      expect(declaration()).toEqual(ownerDeclaration);
      expect(declaration(true)).toEqual(ownerDeclaration);
      for (const tool of registered.create({ senderIsOwner: false })) {
        await expect(tool.execute("denied", {})).rejects.toThrow("owner-authorized sender");
      }
    }
  });

  it.each([
    ["supervision is absent", undefined],
    ["supervision is enabled", { enabled: true }],
  ] as const)(
    "keeps live user-home appServer config for an auto-enabled Codex entry when %s",
    (_label, supervision) => {
      const { registerTool } = registerPlugin({
        runtime: createCodexTestRuntime(() =>
          pluginEntry({
            appServer: { homeScope: "user" },
            ...(supervision ? { supervision } : {}),
          }),
        ),
      });

      const registration = registeredCodexTools(registerTool, "codex_threads");
      // codex_threads exists only while user-home scope or supervision is live,
      // so it proves the plugin config survived the enable-state resolution.
      expect(registration.create({ senderIsOwner: true })[0]?.name).toBe("codex_threads");
    },
  );

  it("drops live plugin config when the Codex entry is explicitly disabled", () => {
    const { registerTool } = registerPlugin({
      runtime: createCodexTestRuntime(() =>
        pluginEntry({ appServer: { homeScope: "user" } }, false),
      ),
    });

    const registration = registeredCodexTools(registerTool, "codex_threads");
    expect(
      registration.factory.create({ senderIsOwner: true, assertInvocationCurrent: () => {} }),
    ).toBeNull();
  });

  it.each([
    ["plugin entry is removed", { plugins: { entries: {} } }],
    ["plugin entry is disabled", pluginEntry({ supervision: { enabled: true } }, false)],
    [
      "global plugin loading is disabled",
      {
        plugins: {
          enabled: false,
          ...pluginEntry({ supervision: { enabled: true } }, true).plugins,
        },
      },
    ],
    [
      "a restrictive allowlist omits Codex",
      {
        plugins: {
          allow: ["other-plugin"],
          ...pluginEntry({ supervision: { enabled: true } }, true).plugins,
        },
      },
    ],
    [
      "the denylist blocks Codex",
      {
        plugins: {
          deny: ["codex"],
          ...pluginEntry({ supervision: { enabled: true } }, true).plugins,
        },
      },
    ],
    ["supervision is explicitly disabled", pluginEntry({ supervision: { enabled: false } }, true)],
  ] as const)("revokes supervision live when %s", async (_label, revokedConfig) => {
    let liveConfig: unknown = pluginEntry({ supervision: { enabled: true } }, true);
    const { registerTool } = registerPlugin({
      pluginConfig: { supervision: { enabled: true } },
      runtime: createCodexTestRuntime(() => liveConfig),
    });
    const registration = registeredCodexTools(registerTool);
    const probe = registration
      .create({ senderIsOwner: true })
      .find((tool) => tool.name === "codex_endpoint_probe");
    if (!probe) {
      throw new Error("missing Codex endpoint probe tool");
    }

    liveConfig = revokedConfig;

    await expect(probe.execute("probe", {})).rejects.toThrow(
      "Codex supervision is disabled in the codex plugin config.",
    );
  });

  it("retires only ended session binding rows in the owning agent scope", async () => {
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = createCodexAppServerBindingStore(stateStore);
    const on = vi.fn();
    plugin.register(
      createCodexTestApi({
        runtime: createCodexTestRuntime(undefined, stateStore),
        on,
      }),
    );
    const sessionEnd = on.mock.calls.find(([name]) => name === "session_end")?.[1] as
      | ((
          event: {
            sessionId: string;
            sessionKey?: string;
            reason?: string;
            nextSessionId?: string;
            nextSessionKey?: string;
          },
          ctx: { agentId?: string; sessionId: string; sessionKey?: string },
        ) => Promise<void>)
      | undefined;
    if (!sessionEnd) {
      throw new Error("missing Codex session_end hook");
    }
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:session-1",
    });
    const setBinding = (target = identity) =>
      bindingStore.mutate(target, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      });

    for (const reason of ["shutdown", "restart", "compaction", "deleted", "unknown"] as const) {
      await expect(setBinding()).resolves.toBe(true);
      await sessionEnd(
        { sessionId: "session-1", sessionKey: "agent:worker:session-1", reason },
        { agentId: "worker", sessionId: "session-1" },
      );
      expect(bindingStore.read(identity)).toMatchObject({ threadId: "thread-1" });
    }
    for (const reason of ["new", "reset", "idle", "daily"] as const) {
      const sessionId = `session-${reason}`;
      const sessionKey = `agent:worker:${sessionId}`;
      const retiredIdentity = sessionBindingIdentity({ agentId: "worker", sessionId, sessionKey });
      await expect(setBinding(retiredIdentity)).resolves.toBe(true);
      expect(bindingStore.read(retiredIdentity)).toMatchObject({ threadId: "thread-1" });
      await sessionEnd({ sessionId, sessionKey, reason }, { agentId: "worker", sessionId });
      expect(bindingStore.read(retiredIdentity)).toBeUndefined();
    }

    // Cross-key handoffs and delayed in-place reset events preserve the binding;
    // physical rollover and an unprovable (keyless) handoff retire it (#106778).
    for (const [sessionId, key, nextSessionId, nextKey, reason, retained] of [
      ["parent", "parent", "child", "dashboard:child", "new", true],
      ["in-place", "in-place", "in-place", undefined, "reset", true],
      ["parent", "parent", "parent-2", undefined, "new", false],
      ["keyless", undefined, "child-2", "dashboard:child-2", "new", false],
    ] as const) {
      const sessionKey = key && `agent:worker:${key}`;
      const nextSessionKey = nextKey && `agent:worker:${nextKey}`;
      const target = sessionBindingIdentity({ agentId: "worker", sessionId, sessionKey });
      await expect(setBinding(target)).resolves.toBe(true);
      await sessionEnd(
        { sessionId, sessionKey, nextSessionId, nextSessionKey, reason },
        { agentId: "worker", sessionId },
      );
      expect(bindingStore.read(target)).toEqual(
        retained ? { threadId: "thread-1", cwd: "/repo" } : undefined,
      );
    }
  });

  it("passes live Codex plugin config into public Codex app-server attempts", async () => {
    const config = codexPluginConfig({
      plugins: { "google-calendar": curatedPlugin("google-calendar") },
    });
    const liveConfig = pluginEntry(config, true);
    const runtime = createCodexTestRuntime(() => liveConfig);
    const { registerAgentHarness } = registerPlugin({
      pluginConfig: { codexPlugins: { enabled: false } },
      runtime,
    });
    const harness = mockCallArg(registerAgentHarness) as ReturnType<
      typeof createCodexAppServerAgentHarness
    >;
    const result = { terminal: { kind: "ok" as const } };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "calendar" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "calendar" },
      {
        bindingStore: expect.any(Object),
        pluginConfig: config,
        runtime,
        runtimeModelId: undefined,
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("enables the native hook relay for public Codex side questions", async () => {
    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: {} },
      bindingStore: testCodexAppServerBindingStore,
    });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });
});
