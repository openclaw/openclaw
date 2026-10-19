import path from "node:path";
import type { AgentHarnessSupportContext } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createNativeSessionBindingScope } from "openclaw/plugin-sdk/agent-harness-session-runtime";
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
const resetSession = {
  agentId: "worker",
  sessionId: "session-1",
  sessionKey: "agent:worker:main",
};
const resetIdentity = sessionBindingIdentity(resetSession);

function makeHarness(
  options: Partial<Parameters<typeof createCodexAppServerAgentHarness>[0]> = {},
) {
  return createCodexAppServerAgentHarness({
    bindingStore: testCodexAppServerBindingStore,
    ...options,
  });
}

const supportHarness = makeHarness();
function supports(context: Partial<AgentHarnessSupportContext>) {
  return supportHarness.supports({ provider: "openai", requestedRuntime: "codex", ...context });
}

function codexConfig(config: Record<string, unknown>) {
  return { plugins: { entries: { codex: { config } } } };
}

function setBinding(
  store: ReturnType<typeof createCodexTestBindingStore>,
  identity: Parameters<typeof store.mutate>[0],
  binding: CodexAppServerThreadBinding = { threadId: "thread-1", cwd: "/repo" },
) {
  return store.mutate(identity, { kind: "set", binding });
}

function makeSqliteBindingStore(
  env: Parameters<typeof createCodexSqliteTestBindingStateStore>[0]["env"],
) {
  return createCodexSqliteTestBindingStateStore({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    env,
  });
}

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
  const harness = supportHarness;

  it("keeps computer-control denies out of the native-surface exemption", () => {
    expect(harness.conversationToolPolicySafeDenyTools).toContain("image_generate");
    expect(harness.conversationToolPolicySafeDenyTools).not.toEqual(
      expect.arrayContaining(["browser", "computer", "mobile_ui", "nodes", "screen"]),
    );
  });

  it.each([
    { enableUltrafast: false, expected: ["priority", "flex"] },
    { enableUltrafast: undefined, expected: ["priority", "ultrafast", "flex"] },
  ])(
    "filters picker tiers with enableUltrafast=$enableUltrafast",
    ({ enableUltrafast, expected }) => {
      const configuredHarness = makeHarness({
        pluginConfig: { appServer: { enableUltrafast: !enableUltrafast } },
      });
      const serviceTiers = ["priority", "ultrafast", "flex"];
      expect(
        configuredHarness.filterModelServiceTiers?.({
          config: codexConfig({ appServer: { enableUltrafast } }),
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
    const websocketHarness = makeHarness({
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
      ...isolatedTask,
    } as unknown as Parameters<NonNullable<typeof harness.runIsolatedCompletionV2>>[0];

    await expect(websocketHarness.runIsolatedCompletionV2?.(params)).resolves.toEqual({
      assistant,
    });
    expect(runHostPreparedIsolatedCompletion).toHaveBeenLastCalledWith(params);
    expect(runCodexIsolatedCompletion).toHaveBeenCalledTimes(nativeCallCount);
  });

  it("delegates locked-session execution only to the voice-call plugin", () => {
    expect(harness.delegatedExecutionPluginIds).toEqual(["voice-call"]);
  });

  it("uses the attempt-scoped Codex config before the live Gateway config", async () => {
    runCodexAppServerAttempt.mockResolvedValueOnce({ terminal: { kind: "ok" } });
    const attemptHarness = makeHarness({
      pluginConfig: { appServer: { homeScope: "agent" } },
      resolvePluginConfig: () => ({ appServer: { homeScope: "agent" } }),
    });
    const params = {
      config: codexConfig({ appServer: { transport: "stdio", homeScope: "user" } }),
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

  it("lets explicitly selected Codex discover a new model with harness-owned auth", () => {
    expect(
      supports({
        modelId: "gpt-future",
        modelProvider: { requestTransportOverrides: "none", preparedAuth: { source: "harness" } },
      }),
    ).toEqual({ supported: true, priority: 100 });
  });

  it.each([
    ["automatic runtime", "auto", { preparedAuth: { source: "harness" } }],
    [
      "authored endpoint",
      "codex",
      {
        baseUrl: "https://relay.example.test/v1",
        preparedAuth: { source: "harness" },
      },
    ],
    ["selected credential", "codex", { preparedAuth: { source: "profile", mode: "api-key" } }],
  ] as const)(
    "does not infer native model access for %s",
    (_label, requestedRuntime, modelProvider) => {
      const result = supports({
        modelId: "gpt-future",
        requestedRuntime,
        modelProvider: { requestTransportOverrides: "none", ...modelProvider },
      });

      expect(result.supported).toBe(false);
      expect(!result.supported ? result.reason : undefined).toContain("not declared");
    },
  );

  it.each([
    ["OAuth", { source: "profile", mode: "oauth", requirement: "subscription" }, true],
    ["Platform key", { source: "profile", mode: "api_key", requirement: "api-key" }, true],
    ["unvalidated subscription", { source: "harness", requirement: "subscription" }, false],
  ] as const)("reports %s reproducibility", (_label, preparedAuth, supported) => {
    const result = supports({
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
    const result = supports({
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
    const result = supports({
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
    const narrowHarness = makeHarness({
      providerIds: ["codex"],
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
    const remoteHarness = makeHarness({
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
  it.each<[string, boolean, string]>([
    ["clears an in-place generation", false, "thread-2"],
    ["repairs a retirement fence", true, "thread-recovered"],
  ])("%s without stranding its replacement", async (_name, fenced, replacement) => {
    const bindingStore = createCodexTestBindingStore();
    const storePath = fenced ? path.join(sessionDirs.make(), "sessions.json") : undefined;
    if (storePath) {
      await upsertSessionEntry({
        agentId: resetSession.agentId,
        sessionKey: resetSession.sessionKey,
        storePath,
        entry: { sessionId: resetSession.sessionId, updatedAt: 1 },
      });
    }
    await setBinding(bindingStore, resetIdentity);
    if (fenced) {
      await bindingStore.retireSessionGeneration(resetIdentity);
    }
    const harness = makeHarness({
      bindingStore,
      resolveConfig: storePath ? () => ({ session: { store: storePath } }) : undefined,
    });
    if (!harness.reset) {
      throw new Error("expected Codex harness reset hook");
    }
    await harness.reset({ ...resetSession, reason: "reset" });
    expect(bindingStore.read(resetIdentity)).toBeUndefined();
    await expect(
      setBinding(bindingStore, resetIdentity, { threadId: replacement, cwd: "/repo" }),
    ).resolves.toBe(true);
    expect(bindingStore.read(resetIdentity)).toMatchObject({ threadId: replacement });
  });

  it("withSessionContextReset removes bindings at the session commit boundary", async () => {
    await withOpenClawTestState({ label: "codex-context-reset" }, async (fixture) => {
      const storePath = path.join(fixture.stateDir, "openclaw-agent.sqlite");
      const state = makeSqliteBindingStore(fixture.env);
      const bindingStore = createCodexAppServerBindingStore(state);
      await setBinding(bindingStore, resetIdentity);
      const harness = makeHarness({ bindingStore });

      await upsertSessionEntry({
        agentId: resetSession.agentId,
        sessionKey: resetSession.sessionKey,
        storePath,
        entry: { sessionId: resetSession.sessionId, updatedAt: 1 },
      });
      await withNativeSessionMutationForTest({
        pluginId: "codex",
        harness,
        hook: "withSessionContextReset",
        target: {
          ...resetIdentity,
          sessionKey: resetSession.sessionKey,
          storePath,
          assertCurrent() {},
        },
        run: async (settle) => {
          await settle();
          expect(state.lookup(bindingStoreKey(resetIdentity))).toBeUndefined();
        },
      });

      await harness.reset?.({ ...resetSession, reason: "deleted" });

      expect(state.lookup(bindingStoreKey(resetIdentity))).toBeUndefined();
    });
  });

  it("withSessionDeletion rejects supervision before invoking the session transaction", async () => {
    await withOpenClawTestState({ label: "codex-supervision-deletion" }, async (fixture) => {
      const bindingStore = createCodexAppServerBindingStore(makeSqliteBindingStore(fixture.env));
      const identity = sessionBindingIdentity({
        ...resetSession,
        sessionId: "supervised",
      });
      await setBinding(bindingStore, identity, {
        threadId: "thread-supervised",
        cwd: "/repo",
        connectionScope: "supervision",
        supervisionSourceThreadId: "thread-source",
        model: "gpt-5.5",
        modelProvider: "openai",
        preserveNativeModel: true,
        conversationSourceTransferComplete: true,
      });
      const harness = makeHarness({ bindingStore });
      const run = vi.fn();
      await expect(
        harness.withSessionDeletion?.(
          {
            ...resetSession,
            sessionId: "supervised",
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
  });
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
      const harness = makeHarness({
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
    bind: (binding: CodexAppServerThreadBinding) => setBinding(bindingStore, identity, binding),
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
    expected?: Awaited<ReturnType<ReturnType<typeof createOwnershipFixture>["resolveOwnership"]>>;
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
    await fixture.bind(binding);

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
      await fixture.bind(binding);

      await clearCodexBindingAfterInvalidImagePayload(
        fixture.bindingStore,
        identity,
        {
          phase: "turn_completed",
          threadId: binding.threadId,
          clientId: binding.clientId,
          error: "synthetic invalid image",
        },
        createNativeSessionBindingScope(() => {}),
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
    await fixture.bind(binding);
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
    await fixture.bind(binding);

    expect(await fixture.resolveOwnership({ sessionId: "session-successor" })).toBeUndefined();
    expect(fixture.bindingStore.read(identity)).toEqual(binding);
  });

  it("does not reuse model ownership after binding retirement", async () => {
    const fixture = createOwnershipFixture();
    await fixture.bind({ ...observedBinding, preserveNativeModel: true });
    expect(await fixture.resolveOwnership()).toEqual({
      model: "native",
      auth: "host",
      modelRef: { provider: "native-provider", model: "native-model" },
    });
    await fixture.bindingStore.retireSessionGeneration(identity);

    expect(await fixture.resolveOwnership()).toBeUndefined();
  });

  it.each([
    ["before", "revoked"],
    ["before", "disposed"],
    ["during", "revoked"],
    ["during", "disposed"],
  ] as const)(
    "rejects ownership %s the binding read when admission is %s",
    async (timing, reason) => {
      const fixture = createOwnershipFixture();
      if (timing === "during") {
        await fixture.bind({ ...observedBinding, preserveNativeModel: true });
      }
      const readBinding = fixture.bindingStore.readAsync.bind(fixture.bindingStore);
      const read = vi.spyOn(fixture.bindingStore, "readAsync");
      let current = true;
      let disposal: Promise<void> | undefined;
      const invalidate = () => {
        if (reason === "disposed") {
          disposal = Promise.resolve(fixture.harness.dispose?.());
        } else {
          current = false;
        }
      };
      if (timing === "before") {
        invalidate();
        await disposal;
      } else {
        read.mockImplementationOnce(async (requestedIdentity) => {
          const binding = await readBinding(requestedIdentity);
          invalidate();
          return binding;
        });
      }
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
        if (timing === "before") {
          expect(read).not.toHaveBeenCalled();
        }
      } finally {
        await disposal;
      }
    },
  );
});
