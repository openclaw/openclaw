import path from "node:path";
import { createNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import {
  getSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  useSessionStoreTempDirs,
  withNativeSessionMutationForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, describe, expect, it, vi } from "vitest";

const runHostPreparedIsolatedCompletion = vi.hoisted(() => vi.fn());
const runCodexIsolatedCompletion = vi.hoisted(() => vi.fn());
const runCodexAppServerAttempt = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  runHostPreparedIsolatedCompletion,
}));
vi.mock("./src/app-server/isolated-completion.js", () => ({
  runCodexIsolatedCompletion,
}));
vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt,
}));

import {
  createCodexAppServerAgentHarness,
  createCodexAppServerNativeCompaction,
} from "./harness.js";
import codexPluginPackage from "./package.json" with { type: "json" };
import { buildCodexRuntimeModelParams } from "./src/app-server/model-runtime.js";
import { clearCodexBindingAfterInvalidImagePayload } from "./src/app-server/run-attempt-state.js";
import {
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
} from "./src/app-server/session-binding-meta.js";
import { createCodexSqliteTestBindingStateStore } from "./src/app-server/session-binding.sqlite.test-helpers.js";
import {
  createCodexTestBindingStore,
  createCodexAppServerBindingStore,
  bindingStoreKey,
  sessionBindingIdentity,
  testCodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./src/app-server/session-binding.test-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-harness-reset-");

const isolatedTask = {
  config: {},
  systemPrompt: "system",
  prompt: "user",
  timeoutMs: 1_000,
  provider: "openai",
  modelId: "gpt-test",
  agentId: "main",
  agentDir: "/tmp/agent",
  workspaceDir: "/tmp/workspace",
  outputTextPolicy: "strict-visible" as const,
};

describe("Codex agent harness supports()", () => {
  it("keeps computer-control denies out of the native-surface exemption", () => {
    expect(harness.conversationToolPolicySafeDenyTools).toContain("image_generate");
    expect(harness.conversationToolPolicySafeDenyTools).not.toEqual(
      expect.arrayContaining(["browser", "computer", "mobile_ui", "nodes", "screen"]),
    );
  });

  const harness = createCodexAppServerAgentHarness({
    bindingStore: testCodexAppServerBindingStore,
  });

  it.each([
    { enableUltrafast: false, expected: ["priority", "flex"] },
    { enableUltrafast: undefined, expected: ["priority", "ultrafast", "flex"] },
  ])(
    "filters picker tiers with enableUltrafast=$enableUltrafast",
    ({ enableUltrafast, expected }) => {
      const configuredHarness = createCodexAppServerAgentHarness({
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: { enableUltrafast: !enableUltrafast } },
      });
      const serviceTiers = ["priority", "ultrafast", "flex"];
      expect(
        configuredHarness.filterModelServiceTiers?.({
          config: {
            plugins: { entries: { codex: { config: { appServer: { enableUltrafast } } } } },
          },
          agentId: "main",
          provider: "openai",
          modelId: "synthetic-tier-model",
          serviceTiers,
        }),
      ).toEqual(expected);
      expect(serviceTiers).toEqual(["priority", "ultrafast", "flex"]);
    },
  );

  it.each(["manual", "native-preflight"] as const)(
    "rejects legacy %s compaction input without inventing System authority",
    async (entry) => {
      const params = {
        sessionId: "legacy-compact",
        sessionFile: "/tmp/legacy-compact.jsonl",
        workspaceDir: "/tmp/workspace",
        trigger: "manual" as const,
      };
      const operation =
        entry === "manual"
          ? harness.compact?.(params)
          : createCodexAppServerNativeCompaction({
              bindingStore: testCodexAppServerBindingStore,
            })({ ...params, nativeCompactionRequest: "required_preflight" });
      await expect(operation).rejects.toThrow(
        "This host did not provide compaction source authority",
      );
    },
  );

  it("keeps V2 host authorization on the prepared direct transport", async () => {
    const nativeCallCount = runCodexIsolatedCompletion.mock.calls.length;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    };
    runHostPreparedIsolatedCompletion.mockResolvedValueOnce({ assistant });
    const websocketHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      pluginConfig: {
        appServer: { transport: "websocket", url: "ws://127.0.0.1:4501" },
      },
    });
    const hostModel = {
      provider: "openai",
      id: "gpt-test",
      api: "openai-responses",
    };
    const hostAuth = { apiKey: "secret", source: "profile:test", mode: "api-key" };
    const params = {
      authorization: {
        owner: "host",
        model: hostModel,
        auth: hostAuth,
      },
      onRequestComplete: vi.fn(),
      ...isolatedTask,
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletionV2>>[0];

    await expect(websocketHarness.runIsolatedCompletionV2?.(params)).resolves.toEqual({
      assistant,
    });
    expect(runHostPreparedIsolatedCompletion).toHaveBeenLastCalledWith(params);
    expect(runCodexIsolatedCompletion).toHaveBeenCalledTimes(nativeCallCount);
  });

  it("forwards native request timing without adding a harness timer", async () => {
    const onRequestComplete = vi.fn();
    const params = {
      ...isolatedTask,
      onRequestComplete,
      authorization: {
        owner: "harness" as const,
        plan: { providerForAuth: "openai", authProfileProviderForAuth: "openai" },
        authProfileStore: { version: 1, profiles: {} },
      },
    };
    await harness.runIsolatedCompletionV2?.(params);
    expect(runCodexIsolatedCompletion).toHaveBeenLastCalledWith(params, {
      pluginConfig: undefined,
    });
    expect(onRequestComplete).not.toHaveBeenCalled();
  });

  it("forwards legacy request timing to the host transport owner", async () => {
    const onRequestComplete = vi.fn();
    const params = {
      ...isolatedTask,
      model: { provider: "openai", id: "gpt-test", api: "openai-responses" },
      auth: { apiKey: "secret", source: "profile:test", mode: "api-key" },
      onRequestComplete,
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletion>>[0];
    await harness.runIsolatedCompletion?.(params);
    expect(runHostPreparedIsolatedCompletion).toHaveBeenLastCalledWith(
      expect.objectContaining({
        onRequestComplete,
        authorization: expect.objectContaining({ owner: "host" }),
      }),
    );
    expect(onRequestComplete).not.toHaveBeenCalled();
  });

  it("delegates locked-session execution only to the voice-call plugin", () => {
    expect(harness.delegatedExecutionPluginIds).toEqual(["voice-call"]);
  });

  it("uses the attempt-scoped Codex config before the live Gateway config", async () => {
    runCodexAppServerAttempt.mockResolvedValueOnce({ terminal: { kind: "ok" } });
    const attemptHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      pluginConfig: { appServer: { homeScope: "agent" } },
      resolvePluginConfig: () => ({ appServer: { homeScope: "agent" } }),
    });
    const params = {
      config: {
        plugins: {
          entries: {
            codex: { config: { appServer: { transport: "stdio", homeScope: "user" } } },
          },
        },
      },
      model: {
        id: "gpt-5.6-sol",
        params: buildCodexRuntimeModelParams("gpt-5.6-sol", "codex-execution-model"),
      },
    } as unknown as Parameters<NonNullable<typeof attemptHarness.runAttempt>>[0];

    await attemptHarness.runAttempt?.(params);

    expect(runCodexAppServerAttempt).toHaveBeenCalledWith(
      params,
      expect.objectContaining({
        pluginConfig: { appServer: { transport: "stdio", homeScope: "user" } },
        runtimeModelId: "codex-execution-model",
      }),
    );
  });

  it.each([{ label: "with harness-owned auth", preparedAuth: { source: "harness" as const } }])(
    "lets explicitly selected Codex discover a new model $label",
    ({ preparedAuth }) => {
      expect(
        harness.supports({
          provider: "openai",
          modelId: "gpt-future",
          requestedRuntime: "codex",
          modelProvider: { requestTransportOverrides: "none", preparedAuth },
        }),
      ).toEqual({ supported: true, priority: 100 });
    },
  );

  it.each([
    {
      label: "automatic runtime selection",
      requestedRuntime: "auto" as const,
      modelProvider: { preparedAuth: { source: "harness" as const } },
    },
    {
      label: "an authored endpoint",
      requestedRuntime: "codex" as const,
      modelProvider: {
        baseUrl: "https://relay.example.test/v1",
        preparedAuth: { source: "harness" as const },
      },
    },
    {
      label: "an owner-selected credential",
      requestedRuntime: "codex" as const,
      modelProvider: { preparedAuth: { source: "profile" as const, mode: "api-key" } },
    },
  ])("does not infer native model access for $label", ({ requestedRuntime, modelProvider }) => {
    const result = harness.supports({
      provider: "openai",
      modelId: "gpt-future",
      requestedRuntime,
      modelProvider: { requestTransportOverrides: "none", ...modelProvider },
    });

    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("not declared");
  });

  it.each([
    {
      label: "forwarded OAuth subscription",
      preparedAuth: { source: "profile", mode: "oauth", requirement: "subscription" } as const,
      supported: true,
    },
    {
      label: "forwarded Platform key profile",
      preparedAuth: { source: "profile", mode: "api_key", requirement: "api-key" } as const,
      supported: true,
    },
    {
      label: "unvalidated harness-native subscription",
      preparedAuth: { source: "harness", requirement: "subscription" } as const,
      supported: false,
    },
  ])("reports $label reproducibility", ({ preparedAuth, supported }) => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api:
          preparedAuth.requirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
        baseUrl:
          preparedAuth.requirement === "api-key"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        preparedAuth,
      },
    });

    expect(result.supported).toBe(supported);
    if (!supported) {
      expect(!result.supported ? result.reason : undefined).toContain("prepared");
    }
  });

  it("rejects a prepared route that does not declare Codex compatibility", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "https://relay.example.test/v1",
        requestTransportOverrides: "none",
        runtimePolicy: { compatibleIds: ["openclaw"] },
      },
    });
    expect(result.supported).toBe(false);
    expect(!result.supported ? result.reason : undefined).toContain("prepared provider route");
  });

  it("rejects authored request overrides defensively", () => {
    const result = harness.supports({
      provider: "openai",
      requestedRuntime: "codex",
      modelProvider: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "present",
        runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        preparedAuth: { source: "harness" },
      },
    });
    expect(result).toEqual({
      supported: false,
      reason: "Codex cannot reproduce authored request transport overrides",
      fallbackRuntime: "openclaw",
    });
  });

  it("honors explicit provider id overrides", () => {
    const narrowHarness = createCodexAppServerAgentHarness({
      providerIds: ["codex"],
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = narrowHarness.supports({ provider: "openai", requestedRuntime: "codex" });
    expect(result.supported).toBe(false);
    expect(narrowHarness.autoSelection?.providerIds).toEqual(["codex"]);
  });

  it("exposes the fail-closed exact runtime artifact validator", async () => {
    if (!harness.runtimeArtifact) {
      throw new Error("expected Codex runtime artifact capability");
    }
    await expect(
      harness.runtimeArtifact.validate({
        id: "codex-app-server:v1:malformed",
        fingerprint: "0".repeat(64),
      }),
    ).resolves.toBe(false);
  });

  it("revalidates remote inference against the harness's current configured endpoint", async () => {
    const { resolveCodexAppServerRuntimeOptions } = await import("./src/app-server/config.js");
    const { captureCodexConfiguredConnection, finalizeCodexConfiguredConnection } =
      await import("./src/app-server/runtime-artifact-connection.js");
    let pluginConfig = {
      appServer: { transport: "websocket" as const, url: "ws://127.0.0.1:1234" },
    };
    const remoteHarness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
      resolvePluginConfig: () => pluginConfig,
    });
    const startOptions = resolveCodexAppServerRuntimeOptions({ pluginConfig }).start;
    const binding = finalizeCodexConfiguredConnection({
      before: captureCodexConfiguredConnection(startOptions),
      startOptions,
      runtimeIdentity: { serverVersion: "0.153.4", userAgent: "codex-test" },
    });
    if (!remoteHarness.runtimeArtifact) {
      throw new Error("expected Codex runtime artifact capability");
    }
    await expect(remoteHarness.runtimeArtifact.validate(binding)).resolves.toBe(true);
    pluginConfig = { appServer: { transport: "websocket", url: "ws://127.0.0.1:5678" } };
    await expect(remoteHarness.runtimeArtifact.validate(binding)).resolves.toBe(false);
  });
});

describe("Codex agent harness reset()", () => {
  it("clears an in-place session generation without stranding its replacement", async () => {
    const bindingStore = createCodexTestBindingStore();
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
    });
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    const harness = createCodexAppServerAgentHarness({ bindingStore });
    if (!harness.reset) {
      throw new Error("expected Codex harness reset hook");
    }

    await harness.reset({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:main",
      reason: "reset",
    });

    expect(bindingStore.read(identity)).toBeUndefined();
    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-2", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
    expect(bindingStore.read(identity)).toMatchObject({ threadId: "thread-2" });
  });

  it("repairs a retirement fence left by an earlier in-place reset", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    const bindingStore = createCodexTestBindingStore();
    const sessionKey = "agent:worker:main";
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey,
    });
    await upsertSessionEntry({
      agentId: identity.agentId,
      sessionKey,
      storePath,
      entry: { sessionId: identity.sessionId, updatedAt: 1 },
    });
    await bindingStore.mutate(identity, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });
    await bindingStore.retireSessionGeneration(identity);
    const harness = createCodexAppServerAgentHarness({
      bindingStore,
      resolveConfig: () => ({ session: { store: storePath } }),
    });

    await harness.reset?.({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey,
      reason: "reset",
    });

    await expect(
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-recovered", cwd: "/repo" },
      }),
    ).resolves.toBe(true);
  });

  it.each(["withSessionContextReset"] as const)(
    "%s removes bindings at the session commit boundary",
    async (hook) => {
      await withOpenClawTestState({ label: "codex-context-reset" }, async (fixture) => {
        const storePath = path.join(fixture.stateDir, "openclaw-agent.sqlite");
        const state = createCodexSqliteTestBindingStateStore({
          namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
          maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          env: fixture.env,
        });
        const bindingStore = createCodexAppServerBindingStore(state);
        const identity = sessionBindingIdentity({
          agentId: "worker",
          sessionId: "session-1",
          sessionKey: "agent:worker:main",
        });
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-1", cwd: "/repo" },
        });
        const harness = createCodexAppServerAgentHarness({ bindingStore });

        await upsertSessionEntry({
          agentId: identity.agentId,
          sessionKey: "agent:worker:main",
          storePath,
          entry: { sessionId: identity.sessionId, updatedAt: 1 },
        });
        await withNativeSessionMutationForTest({
          pluginId: "codex",
          harness,
          hook,
          target: { ...identity, sessionKey: "agent:worker:main", storePath, assertCurrent() {} },
          run: async (settle) => {
            await settle();
            expect(state.lookup(bindingStoreKey(identity))).toBeUndefined();
          },
        });

        await harness.reset?.({
          agentId: "worker",
          sessionId: "session-1",
          sessionKey: "agent:worker:main",
          reason: "deleted",
        });

        expect(state.lookup(bindingStoreKey(identity))).toBeUndefined();
      });
    },
  );

  it.each(["withSessionDeletion"] as const)(
    "%s rejects supervision before invoking the session transaction",
    async (hook) => {
      await withOpenClawTestState({ label: "codex-supervision-deletion" }, async (fixture) => {
        const bindingStore = createCodexAppServerBindingStore(
          createCodexSqliteTestBindingStateStore({
            namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
            maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
            overflowPolicy: "reject-new",
            env: fixture.env,
          }),
        );
        const identity = sessionBindingIdentity({
          agentId: "worker",
          sessionId: "supervised",
          sessionKey: "agent:worker:main",
        });
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: {
            threadId: "thread-supervised",
            cwd: "/repo",
            connectionScope: "supervision",
            supervisionSourceThreadId: "thread-source",
            model: "gpt-5.5",
            modelProvider: "openai",
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
          },
        });
        const harness = createCodexAppServerAgentHarness({ bindingStore });
        const run = vi.fn();
        await expect(
          harness[hook]?.(
            {
              agentId: "worker",
              sessionId: "supervised",
              sessionKey: "agent:worker:main",
              assertCurrent() {},
            },
            run,
          ),
        ).rejects.toThrow("owned by supervision");
        expect(run).not.toHaveBeenCalled();
        expect(bindingStore.read(identity)).toMatchObject({
          threadId: "thread-supervised",
        });
      });
    },
  );
});

describe("Codex agent harness dispose()", () => {
  it("runs this build's shared-client disposer and ignores a bare-name one", async () => {
    // The disposer slot is keyed by plugin version like the client table: an old build's
    // harness must close that build's clients even after a newer build's module evaluated.
    const versionedSlot = Symbol.for(
      `openclaw.codexAppServerClientDisposer@${codexPluginPackage.version}`,
    );
    const bareSlot = Symbol.for("openclaw.codexAppServerClientDisposer");
    const globalState = globalThis as Record<symbol, unknown>;
    const previous = { versioned: globalState[versionedSlot], bare: globalState[bareSlot] };
    const versioned = vi.fn(async () => {});
    const bare = vi.fn(async () => {});
    globalState[versionedSlot] = versioned;
    globalState[bareSlot] = bare;
    try {
      const harness = createCodexAppServerAgentHarness({
        bindingStore: createCodexTestBindingStore(),
      });
      await harness.dispose?.();
      expect(versioned).toHaveBeenCalledTimes(1);
      expect(bare).not.toHaveBeenCalled();
    } finally {
      for (const [slot, value] of [
        [versionedSlot, previous.versioned],
        [bareSlot, previous.bare],
      ] as const) {
        if (value === undefined) {
          delete globalState[slot];
        } else {
          globalState[slot] = value;
        }
      }
    }
  });
});

const session = {
  agentId: "worker",
  sessionId: "session-one",
  sessionKey: "agent:worker:ownership",
};
const identity = sessionBindingIdentity(session);
const observedBinding: CodexAppServerThreadBinding = {
  threadId: "native-thread",
  cwd: "/synthetic-workspace",
  model: "native-model",
  modelProvider: "native-provider",
  authProfileId: "selected-profile",
};

function createOwnershipFixture() {
  const bindingStore = createCodexTestBindingStore();
  const harness = createCodexAppServerAgentHarness({ bindingStore });
  const resolveOwnership = harness.resolveSessionRuntimeOwnershipAsync?.bind(harness);
  if (!resolveOwnership) {
    throw new Error("expected Codex session runtime ownership capability");
  }
  return {
    bindingStore,
    harness,
    resolveOwnership: (overrides: Partial<Parameters<typeof resolveOwnership>[0]> = {}) =>
      resolveOwnership({
        version: 2,
        ...session,
        assertCurrent() {},
        readPreviousSessionId: async () => undefined,
        ...overrides,
      }),
  };
}

describe("Codex session runtime ownership", () => {
  it.each<{
    name: string;
    binding: CodexAppServerThreadBinding;
    expected?: {
      model: "native";
      auth: "native" | "host";
      modelRef?: { provider: string; model: string };
    };
  }>([
    { name: "ordinary binding with an observed native model", binding: observedBinding },
    {
      name: "pending supervision without a model selection",
      binding: {
        threadId: "native-source",
        cwd: "/synthetic-workspace",
        connectionScope: "supervision",
        supervisionSourceThreadId: "native-source",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
        pendingSupervisionBranch: { sourceThreadId: "native-source" },
      },
      expected: { model: "native", auth: "native" },
    },
  ])("classifies $name without changing its binding", async ({ binding, expected }) => {
    const fixture = createOwnershipFixture();
    await fixture.bindingStore.mutate(identity, { kind: "set", binding });

    const readPreviousSessionId = vi.fn(async () => undefined);
    expect(await fixture.resolveOwnership({ readPreviousSessionId })).toEqual(expected);
    expect(readPreviousSessionId).not.toHaveBeenCalled();
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
  });

  it.each([false, true])(
    "respects expected native ownership during image cleanup (%s)",
    async (expected) => {
      const fixture = createOwnershipFixture();
      const binding = {
        ...observedBinding,
        clientId: "image-owner",
        preserveNativeModel: true as const,
      };
      await fixture.bindingStore.mutate(identity, { kind: "set", binding });

      await clearCodexBindingAfterInvalidImagePayload(
        fixture.bindingStore,
        identity,
        {
          phase: "turn_completed",
          threadId: binding.threadId,
          clientId: binding.clientId,
          error: "synthetic invalid image",
        },
        createNativeSessionBindingAuthority([], () => {}),
        expected ? { model: "native", auth: "host" } : undefined,
      );

      expect(fixture.bindingStore.read(identity)).toEqual(expected ? binding : undefined);
    },
  );

  it("reads native auth ownership from the recorded predecessor without adopting it", async () => {
    const root = sessionDirs.make();
    const storePath = path.join(root, "sessions.json");
    const scope = { agentId: session.agentId, sessionKey: session.sessionKey, storePath };
    const fixture = createOwnershipFixture();
    const successor = { ...identity, sessionId: "session-successor" };
    const binding: CodexAppServerThreadBinding = {
      ...observedBinding,
      preserveNativeModel: true,
      connectionScope: "supervision",
      supervisionSourceThreadId: "native-source",
      conversationSourceTransferComplete: true,
    };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: session.sessionId, updatedAt: 1 },
    });
    await fixture.bindingStore.mutate(identity, { kind: "set", binding });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: successor.sessionId }) });
    const readPreviousSessionId = async () => {
      const entry = getSessionEntry({
        ...scope,
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
      });
      return entry?.sessionId === successor.sessionId ? entry.previousSessionId : undefined;
    };

    expect(
      await fixture.resolveOwnership({
        sessionId: successor.sessionId,
        readPreviousSessionId,
        storePath,
        config: { session: { store: path.join(root, "other", "sessions.json") } },
      }),
    ).toEqual({
      model: "native",
      auth: "native",
      modelRef: { provider: binding.modelProvider, model: binding.model },
    });
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
    expect(fixture.bindingStore.read(successor)).toBeUndefined();
  });

  it("does not claim a stale physical generation or reclaim its binding", async () => {
    const fixture = createOwnershipFixture();
    const binding = { ...observedBinding, preserveNativeModel: true as const };
    await fixture.bindingStore.mutate(identity, { kind: "set", binding });

    expect(await fixture.resolveOwnership({ sessionId: "session-successor" })).toBeUndefined();
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
  });

  it("does not reuse model ownership after binding retirement", async () => {
    const fixture = createOwnershipFixture();
    await fixture.bindingStore.mutate(identity, {
      kind: "set",
      binding: { ...observedBinding, preserveNativeModel: true },
    });
    expect(await fixture.resolveOwnership()).toEqual({
      model: "native",
      auth: "host",
      modelRef: { provider: "native-provider", model: "native-model" },
    });
    await fixture.bindingStore.retireSessionGeneration(identity);

    expect(await fixture.resolveOwnership()).toBeUndefined();
  });

  it.each(["revoked", "disposed"] as const)(
    "refuses %s admission before reading private state",
    async (reason) => {
      const fixture = createOwnershipFixture();
      const read = vi.spyOn(fixture.bindingStore, "readAsync");
      if (reason === "disposed") {
        await fixture.harness.dispose?.();
      }
      const assertCurrent = () => {
        if (reason === "revoked") {
          throw new Error("admission revoked");
        }
      };

      await expect(fixture.resolveOwnership({ assertCurrent })).rejects.toThrow(
        reason === "disposed" ? "harness is disposed" : "admission revoked",
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "disposed"] as const)(
    "rejects ownership when admission becomes %s during the binding read",
    async (reason) => {
      const fixture = createOwnershipFixture();
      await fixture.bindingStore.mutate(identity, {
        kind: "set",
        binding: { ...observedBinding, preserveNativeModel: true },
      });
      const readBinding = fixture.bindingStore.readAsync.bind(fixture.bindingStore);
      let current = true;
      const cleanup: { disposal?: Promise<void> } = {};
      vi.spyOn(fixture.bindingStore, "readAsync").mockImplementationOnce(
        async (requestedIdentity) => {
          const binding = await readBinding(requestedIdentity);
          if (reason === "disposed") {
            const disposal = fixture.harness.dispose?.();
            if (disposal) {
              cleanup.disposal = disposal;
            }
          } else {
            current = false;
          }
          return binding;
        },
      );
      try {
        await expect(
          fixture.resolveOwnership({
            assertCurrent() {
              if (!current) {
                throw new Error("admission revoked");
              }
            },
          }),
        ).rejects.toThrow(reason === "disposed" ? "harness is disposed" : "admission revoked");
      } finally {
        if (cleanup.disposal) {
          await cleanup.disposal;
        }
      }
    },
  );
});
