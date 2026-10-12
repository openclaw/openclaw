// Codex tests cover index plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  current?: () => unknown,
  stateStore = createCodexTestBindingStateStore(),
) {
  return {
    modelAuth,
    ...(current ? { config: { current } } : {}),
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
  return createTestPluginApi({
    id: "codex",
    name: "Codex",
    source: "test",
    config: {},
    pluginConfig: {},
    ...overrides,
    runtime: overrides.runtime ?? createCodexTestRuntime(),
  });
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
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
      const calibration = new DatabaseSync(":memory:");
      try {
        calibration.exec("CREATE TABLE calibration (value INTEGER)");
        calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
        const read = calibration.prepare("SELECT value FROM calibration");
        read.get();
        read.all();
        expect([...read.iterate()]).toHaveLength(1);
        for (const operation of sql) {
          expect(operation).toHaveBeenCalled();
          operation.mockClear();
        }
      } finally {
        calibration.close();
      }
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

  it("registers request-scoped surfaces with explicit multi-agent ownership", () => {
    const registerAgentHarness = vi.fn();
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    const registerSessionCatalog = vi.fn();

    expect(() =>
      plugin.register(
        createCodexTestApi({
          config: explicitAgentConfig,
          runtime: createCodexTestRuntime(() => explicitAgentConfig),
          registerAgentHarness,
          registerNodeHostCommand,
          registerNodeInvokePolicy,
          registerSessionCatalog,
        }),
      ),
    ).not.toThrow();

    expect(registerAgentHarness).toHaveBeenCalledOnce();
    expect(registerSessionCatalog).toHaveBeenCalledOnce();
    expect(registerNodeHostCommand.mock.calls.map(([command]) => command.command)).toEqual(
      expect.arrayContaining([
        "codex.appServer.threads.list.v1",
        "codex.appServer.thread.turns.list.v1",
        "codex.terminal.resume.v1",
        "codex.exec-server.stdio.v1",
      ]),
    );
    const nodeExecServerCommand = registerNodeHostCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.command === "codex.exec-server.stdio.v1");
    expect(nodeExecServerCommand).toMatchObject({
      command: "codex.exec-server.stdio.v1",
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
    expect(nodeExecServerPolicy.defaultPlatforms).toBeUndefined();
  });

  it("lets native session discovery be disabled without disabling the Codex plugin", () => {
    const registerAgentHarness = vi.fn();
    const registerNodeHostCommand = vi.fn();
    const registerProvider = vi.fn();
    const registerSessionCatalog = vi.fn();
    plugin.register(
      createCodexTestApi({
        config: explicitAgentConfig,
        pluginConfig: { sessionCatalog: { enabled: false } },
        registerAgentHarness,
        registerNodeHostCommand,
        registerProvider,
        registerSessionCatalog,
      }),
    );

    expect(registerAgentHarness).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "codex",
        auth: [],
        prepareSyntheticAuth: expect.any(Function),
      }),
    );
    const nodeCommands = registerNodeHostCommand.mock.calls.map(
      ([command]) => (command as { command: string }).command,
    );
    expect(nodeCommands).toEqual([
      "codex.cli.sessions.list",
      "codex.cli.session.resume",
      "codex.exec-server.stdio.v1",
    ]);
    expect(nodeCommands).not.toContain("codex.appServer.threads.list.v1");
    expect(nodeCommands).not.toContain("codex.appServer.thread.turns.list.v1");
    expect(registerSessionCatalog).not.toHaveBeenCalled();
  });

  it("registers the five shipped supervision tools only when supervision is enabled", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(
      createCodexTestApi({
        pluginConfig: { supervision: { enabled: true } },
        registerTool,
      }),
    );

    const registration = registeredCodexTools(registerTool);
    expect(registration.options).toEqual({ names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES] });
    expect(registration.create({ senderIsOwner: true }).map((tool) => tool.name)).toEqual([
      ...CODEX_SUPERVISION_COMPAT_TOOL_NAMES,
    ]);
    expect(registration.create({ senderIsOwner: false })).toEqual([]);
    expect(registration.create()).toEqual([]);
  });

  it.each([
    ["supervision is absent", undefined],
    ["supervision is enabled", { enabled: true }],
  ] as const)(
    "keeps live user-home appServer config for an auto-enabled Codex entry when %s",
    (_label, supervision) => {
      const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
      plugin.register(
        createCodexTestApi({
          // No explicit plugins.entries.codex.enabled: core auto-enables the
          // plugin from this config block, so the harness must keep honoring it.
          runtime: createCodexTestRuntime(() => ({
            plugins: {
              entries: {
                codex: {
                  config: {
                    appServer: { homeScope: "user" },
                    ...(supervision ? { supervision } : {}),
                  },
                },
              },
            },
          })),
          registerTool,
        }),
      );

      const registration = registeredCodexTools(registerTool, "codex_threads");
      // codex_threads exists only while user-home scope or supervision is live,
      // so it proves the plugin config survived the enable-state resolution.
      expect(registration.create({ senderIsOwner: true })[0]?.name).toBe("codex_threads");
    },
  );

  it("drops live plugin config when the Codex entry is explicitly disabled", () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register(
      createCodexTestApi({
        runtime: createCodexTestRuntime(() => ({
          plugins: {
            entries: {
              codex: {
                enabled: false,
                config: { appServer: { homeScope: "user" } },
              },
            },
          },
        })),
        registerTool,
      }),
    );

    const registration = registeredCodexTools(registerTool, "codex_threads");
    expect(
      registration.factory.create({ senderIsOwner: true, assertInvocationCurrent: () => {} }),
    ).toBeNull();
  });

  it.each([
    ["plugin entry is removed", { plugins: { entries: {} } }],
    [
      "plugin entry is disabled",
      {
        plugins: {
          entries: {
            codex: { enabled: false, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "global plugin loading is disabled",
      {
        plugins: {
          enabled: false,
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "a restrictive allowlist omits Codex",
      {
        plugins: {
          allow: ["other-plugin"],
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "the denylist blocks Codex",
      {
        plugins: {
          deny: ["codex"],
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "supervision is explicitly disabled",
      {
        plugins: {
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: false } } },
          },
        },
      },
    ],
  ] as const)("revokes supervision live when %s", async (_label, revokedConfig) => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    let liveConfig: unknown = {
      plugins: {
        entries: {
          codex: { enabled: true, config: { supervision: { enabled: true } } },
        },
      },
    };
    plugin.register(
      createCodexTestApi({
        pluginConfig: { supervision: { enabled: true } },
        runtime: createCodexTestRuntime(() => liveConfig),
        registerTool,
      }),
    );
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

    // Cross-key handoff (e.g. dashboard "New Chat"/fork): the parent's still-live
    // binding must survive because the successor lives under a different key and
    // owns its own Codex thread. See #106778.
    const parent = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "parent-1",
      sessionKey: "agent:worker:parent-1",
    });
    await bindingStore.mutate(parent, {
      kind: "set",
      binding: { threadId: "thread-parent", cwd: "/repo" },
    });
    await sessionEnd(
      {
        sessionId: "parent-1",
        sessionKey: "agent:worker:parent-1",
        reason: "new",
        nextSessionId: "child-1",
        nextSessionKey: "agent:worker:dashboard:child-1",
      },
      { agentId: "worker", sessionId: "parent-1" },
    );
    expect(bindingStore.read(parent)).toMatchObject({ threadId: "thread-parent" });

    // In-place reset cleanup is awaited before the replacement starts. Its
    // delayed session_end event must not retire that same-id replacement.
    const inPlace = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "in-place-1",
      sessionKey: "agent:worker:in-place",
    });
    await bindingStore.mutate(inPlace, {
      kind: "set",
      binding: { threadId: "thread-in-place-replacement", cwd: "/repo" },
    });
    await sessionEnd(
      {
        sessionId: "in-place-1",
        sessionKey: "agent:worker:in-place",
        reason: "reset",
        nextSessionId: "in-place-1",
      },
      { agentId: "worker", sessionId: "in-place-1" },
    );
    expect(bindingStore.read(inPlace)).toMatchObject({
      threadId: "thread-in-place-replacement",
    });

    // A same-key replacement that still names the successor id (physical rollover)
    // has no distinct nextSessionKey, so it retires as before.
    await sessionEnd(
      {
        sessionId: "parent-1",
        sessionKey: "agent:worker:parent-1",
        reason: "new",
        nextSessionId: "parent-2",
      },
      { agentId: "worker", sessionId: "parent-1" },
    );
    expect(bindingStore.read(parent)).toBeUndefined();

    // Unknown current key: a handoff cannot be proven, so a successor key alone
    // must not skip cleanup — the conservative path retires as before #106778.
    const keyless = sessionBindingIdentity({ agentId: "worker", sessionId: "keyless-1" });
    await bindingStore.mutate(keyless, {
      kind: "set",
      binding: { threadId: "thread-keyless", cwd: "/repo" },
    });
    await sessionEnd(
      {
        sessionId: "keyless-1",
        reason: "new",
        nextSessionId: "child-2",
        nextSessionKey: "agent:worker:dashboard:child-2",
      },
      { agentId: "worker", sessionId: "keyless-1" },
    );
    expect(bindingStore.read(keyless)).toBeUndefined();
  });

  it("enables the native hook relay for public Codex app-server attempts", async () => {
    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: {} },
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = { terminal: { kind: "ok" as const } };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("passes live Codex plugin config into public Codex app-server attempts", async () => {
    const registerAgentHarness = vi.fn();
    const liveConfig = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                plugins: {
                  "google-calendar": {
                    marketplaceName: "openai-curated",
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
    };
    const runtime = createCodexTestRuntime(() => liveConfig);
    plugin.register(
      createCodexTestApi({
        pluginConfig: { codexPlugins: { enabled: false } },
        runtime,
        registerAgentHarness,
      }),
    );
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
        pluginConfig: liveConfig.plugins.entries.codex.config,
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
