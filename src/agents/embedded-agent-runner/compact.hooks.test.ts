// Hook integration coverage for direct and queued embedded compaction.
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { getModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import type { CommandQueueEnqueueOptions } from "../../process/command-queue.types.js";
import type { SessionTurnAdmission } from "../../sessions/session-controller.admission.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { getModelProviderLocalServiceReconciler } from "../provider-local-service-reconcile.js";
import { createSessionMaintenanceOwner } from "../session-maintenance/coordinator.js";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../sessions/agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import {
  expectRecordFields,
  findMockCall,
  mockCallArg,
} from "./compact.hooks.assertions.test-support.js";
import {
  acquiredPreparedModelRuntime,
  expectedNativeCompactionOptions,
  useCompactHooksSessionFixture,
} from "./compact.hooks.fixture.test-support.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  attemptServerEndpointCompactionMock,
  applyExtraParamsToAgentMock,
  buildAgentRuntimePlanMock,
  buildConfiguredAgentSystemPromptMock,
  resolveBootstrapContextForRunMock,
  contextEngineCompactMock,
  createAgentSessionMock,
  createOpenClawCodingToolsMock,
  enqueueCommandInLaneMock,
  ensureAuthProfileStoreMock,
  estimateTokensMock,
  getApiKeyForModelMock,
  getMemorySearchManagerMock,
  resolveMemorySearchConfigMock,
  resolveSessionAgentIdMock,
  getHistoryLimitFromSessionKeyMock,
  hookRunner,
  limitHistoryTurnsMock,
  listRegisteredPluginAgentPromptGuidanceMock,
  loadCompactHooksHarness,
  maybeCompactAgentHarnessSessionMock,
  resolveAgentHarnessPolicyMock,
  registerProviderStreamForModelMock,
  resolveProviderEntryApiKeyProfileReferenceMock,
  resolveContextWindowInfoMock,
  resolveCliBackendConfigMock,
  resolveContextEngineMock,
  resolveDefaultAgentDirMock,
  resolveEmbeddedAgentStreamMock,
  resolveModelAsyncMock,
  resolveModelMock,
  resolveSandboxContextMock,
  resolveSkillsPromptMock,
  resolveSessionAgentIdsMock,
  runCliAgentMock,
  selectAgentHarnessForPreparedModelProvidersMock,
  sessionMessages,
  sessionCompactImpl,
  triggerInternalHookMock,
} from "./compact.hooks.harness.js";
import {
  registerDirectProviderRefreshTests,
  registerQueuedProviderRefreshTest,
} from "./compact.hooks.memory-refresh.test-support.js";
import {
  createCompactHooksPreparedModelRuntime,
  createCompactHooksResolvedModel,
  type CompactHooksQueuedCompaction,
} from "./compact.hooks.metadata.test-support.js";
import {
  mockPendingContextEngineCompaction,
  mockPendingNativeCompaction,
} from "./compact.hooks.pending.test-support.js";
import { registerCompactionSafeguardTests } from "./compact.hooks.safeguard.test-support.js";
import { abortEmbeddedAgentRun, isEmbeddedAgentRunHandleActive } from "./runs.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  steerTestSessionTurn,
} from "./runs.test-support.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let compactEmbeddedAgentSession: CompactHooksQueuedCompaction;
let compactTesting: typeof import("./compact.hooks.owner-test-support.js");
let configRuntime: typeof import("../../config/runtime-snapshot.js");

let TEST_STORE_PATH: string;
let TEST_SESSION_ID: string;
const TEST_SESSION_KEY = "agent:main:session-1";
const compactionFixture = useCompactHooksSessionFixture(TEST_SESSION_KEY);
let TEST_SESSION_FILE: string;
let TEST_WORKSPACE_DIR: string;
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
function plannedCompactionPluginSelections(
  config: OpenClawConfig,
  metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] }),
) {
  const derive = expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.mock.calls[0]?.[1]?.deriveRuntimePluginSelections,
    "admitted compaction selection recipe",
  );
  return derive({ config, metadataSnapshot });
}

function mockResolvedModel(supportsTools?: boolean, queued = false) {
  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation(
    (
      provider = "openai",
      modelId = queued ? "gpt-5.5" : "fake",
      _agentDir?: string,
      cfg?: unknown,
    ) => {
      const providerOptions = providerSettings(cfg, provider);
      const resolved = createCompactHooksResolvedModel(provider, modelId);
      const api = providerOptions?.api ?? "openai-responses";
      const subscription = api === "openai-chatgpt-responses";
      return {
        ...resolved,
        model: {
          ...resolved.model,
          api,
          baseUrl: queued
            ? (providerOptions?.baseUrl ??
              (subscription
                ? "https://chatgpt.com/backend-api/codex"
                : "https://api.openai.com/v1"))
            : providerOptions?.baseUrl?.trim() || "https://api.openai.com/v1",
          ...(queued ? { contextWindow: subscription ? 272_000 : 1_050_000 } : {}),
          ...(supportsTools === undefined ? {} : { compat: { supportsTools } }),
        },
      };
    },
  );
}

function compactionConfig(mode: "await" | "off" | "async") {
  return defaultsConfig({ compaction: { postIndexSync: mode } }) as never;
}

function directCompactionArgs() {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_KEY,
    workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
  };
}

function wrappedCompactionArgs(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: TEST_SESSION_KEY,
    sessionTarget: {
      agentId: "main",
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_SESSION_KEY,
      storePath: TEST_STORE_PATH,
    },
    workspaceDir: TEST_WORKSPACE_DIR,
    customInstructions: TEST_CUSTOM_INSTRUCTIONS,
    ...overrides,
  };
}

async function nativeCompactionArgs(
  overrides: Record<string, unknown> & { agentHarnessId: string },
) {
  const params = wrappedCompactionArgs({ ...overrides, modelSelectionLocked: true });
  await upsertSessionEntryCore(params.sessionTarget, {
    sessionId: params.sessionId,
    updatedAt: 1,
    modelSelectionLocked: true,
    agentHarnessId: overrides.agentHarnessId,
  });
  return params;
}

function expectCall(mock: Mock, fields: Record<string, unknown>, ...rest: unknown[]) {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining(fields), ...rest);
}

function expectNoCalls(...mocks: Mock[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const abortedCompaction = { ok: false, compacted: false, reason: "compaction aborted" };

function useCodexPolicy() {
  const policy = { runtime: "codex", runtimeSource: "model" };
  resolveAgentHarnessPolicyMock.mockReturnValue(policy);
}

function mockContextEngine(ownsCompaction: boolean, once = false, extra: object = {}) {
  const engine = { info: { ownsCompaction }, compact: contextEngineCompactMock, ...extra };
  if (once) {
    resolveContextEngineMock.mockResolvedValueOnce(engine);
  } else {
    resolveContextEngineMock.mockResolvedValue(engine);
  }
}

function compactionSummary(summary: string, firstKeptEntryId: string) {
  return { summary, firstKeptEntryId, tokensBefore: 120, details: { ok: true } };
}

function serverEndpointCompaction(
  input: Parameters<typeof attemptServerEndpointCompactionMock>[0],
) {
  input.onCompactionCommitted?.(1_000);
  return {
    item: { type: "compaction", encrypted_content: "opaque" },
    usage: { input_tokens: 1_000, output_tokens: 200 },
  };
}

function authPlan<T extends object>(extra: T, modelId = "gpt-5.5") {
  return {
    providerForAuth: "openai",
    modelId,
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: "api-key",
    ...extra,
  } as const;
}

function defaultsConfig<T>(defaults: T) {
  return { agents: { defaults } };
}

function providerConfig<T>(provider: string, settings: T) {
  return { models: { providers: { [provider]: settings } } };
}

function rateLimited() {
  return Object.assign(new Error("primary compaction rate limited"), {
    status: 429,
    code: "rate_limit_exceeded",
  });
}

function providerSettings(config: unknown, provider: string) {
  return (config as OpenClawConfig | undefined)?.models?.providers?.[provider];
}

function mockNativeCompactionSuccess() {
  maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
  });
}

function compactionTool<T extends object>(name: string, fields: T) {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
    ...fields,
  };
}

function mockDelegatingEngine(
  info: { ownsCompaction: boolean } | { id: string; name: string; version: string } = {
    ownsCompaction: false,
  },
) {
  resolveContextEngineMock.mockResolvedValue({
    info,
    compact: delegateCompactionToRuntime,
  } as never);
}

function blockQueuedLane() {
  const entered = createDeferred();
  const release = createDeferred();
  enqueueCommandInLaneMock.mockImplementationOnce(async (_lane, task) => {
    entered.resolve();
    await release.promise;
    return await task();
  });
  return { entered, release };
}

function codexArgs(overrides: Record<string, unknown> = {}) {
  return { provider: "openai", model: "gpt-5.5", agentHarnessId: "codex", ...overrides };
}

function openaiRoute(baseUrl = "https://api.openai.com/v1", modelId = "gpt-5.5") {
  return {
    provider: "openai",
    modelId,
    api: "openai-responses",
    baseUrl,
    authRequirement: "api-key",
    requestTransportOverrides: "none",
  } as const;
}

const compactDirect = (overrides: Record<string, unknown> = {}) =>
  compactEmbeddedAgentSessionDirect(wrappedCompactionArgs(overrides));
const compactQueued = (overrides: Record<string, unknown> = {}) =>
  compactEmbeddedAgentSession(wrappedCompactionArgs(overrides));

const compactWorkspace = (overrides: Record<string, unknown> = {}) =>
  compactEmbeddedAgentSessionDirect({ ...directCompactionArgs(), ...overrides });
const compactNative = async (
  overrides: Parameters<typeof nativeCompactionArgs>[0],
  host?: Parameters<CompactHooksQueuedCompaction>[1],
) => compactEmbeddedAgentSession(await nativeCompactionArgs(overrides), host);

function createPreparedCodexCompactionPlans(modelId = "gpt-5.5") {
  const modelRoute = {
    ...openaiRoute(undefined, modelId),
    runtimePolicy: { compatibleIds: ["codex"] },
  } as const;
  const runtimeAuthPlan = authPlan({ modelRoute }, modelId);
  return {
    modelRoute,
    runtimeAuthPlan,
    runtimePlan: {
      resolvedRef: {
        provider: "openai",
        modelId,
        modelApi: "openai-responses",
        harnessId: "codex",
      },
      auth: runtimeAuthPlan,
    } as never,
  };
}

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactTesting = await import("./compact.hooks.owner-test-support.js");
  configRuntime = await import("../../config/runtime-snapshot.js");
  compactEmbeddedAgentSessionDirect = (params) => {
    configRuntime.setRuntimeConfigSnapshot(params.config ?? {});
    return loaded.compactEmbeddedAgentSessionDirect({ agentId: "main", ...params });
  };
  compactEmbeddedAgentSession = (params, host) => {
    configRuntime.setRuntimeConfigSnapshot(params.config ?? {});
    return loaded.compactEmbeddedAgentSession(params, host);
  };
  TEST_STORE_PATH = await compactionFixture.prepare();
});

beforeEach(async () => {
  configRuntime.setRuntimeConfigSnapshot({});
  ({
    workspaceDir: TEST_WORKSPACE_DIR,
    sessionFile: TEST_SESSION_FILE,
    sessionId: TEST_SESSION_ID,
  } = await compactionFixture.prepareSession());
});

afterEach(() => configRuntime.clearRuntimeConfigSnapshot());

describe("compactEmbeddedAgentSessionDirect hooks", () => {
  beforeEach(() => mockResolvedModel());

  it("never retries a recorded terminal failure", async () => {
    mockContextEngine(false);
    const failure = Object.freeze(
      Object.assign(new Error("Reasoning is mandatory for this endpoint"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    );
    recordModelFallbackStop(failure);
    sessionCompactImpl.mockRejectedValueOnce(failure);
    const result = await compactDirect({
      provider: "openai",
      model: "fixture-primary",
      modelFallbacksOverride: ["openai/fixture-fallback"],
      thinkLevel: "off",
      customInstructions: "preserve the committed state",
    });
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(createAgentSessionMock).toHaveBeenCalledOnce();
    expect(sessionCompactImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, compacted: false });
  });

  it("restricts endpoint tools and excludes private skills", async () => {
    resolveSkillsPromptMock.mockResolvedValue("PRIVATE_SKILL_MARKER");
    createOpenClawCodingToolsMock.mockReturnValue(
      ["read", "exec"].map((name) => compactionTool(name, {})),
    );
    buildConfiguredAgentSystemPromptMock.mockImplementation((params) =>
      JSON.stringify({
        promptMode: params.promptMode,
        skillsPrompt: params.skillsPrompt ?? null,
        toolNames: params.tools?.map((tool) => tool.name),
      }),
    );
    let endpointSystemPrompt: string | undefined;
    attemptServerEndpointCompactionMock.mockImplementationOnce(async (input) => {
      endpointSystemPrompt = input.context.systemPrompt;
      return serverEndpointCompaction(input);
    });
    const result = await compactDirect({
      provider: "xai",
      model: "grok-4.5",
      trigger: "manual",
      modelCallUrgency: "background",
      toolsAllow: ["read"],
      customInstructions: undefined,
      config: providerConfig("xai", {
        api: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        models: [],
      }),
    });
    expect(result).toMatchObject({ compacted: true, compactionKind: "server-endpoint" });
    expect(result.result).not.toHaveProperty("summary");
    expect(mockCallArg(applyExtraParamsToAgentMock, 0, 11)).toMatchObject({
      modelCallUrgency: "foreground",
      nativeWebSearchPolicyContext: { webSearchEnabled: false, runtimeToolAllowlist: [] },
    });
    expect(endpointSystemPrompt).toBeDefined();
    expect(JSON.parse(endpointSystemPrompt ?? "{}")).toEqual({
      promptMode: "minimal",
      skillsPrompt: null,
      toolNames: ["read"],
    });
  });

  it("applies the routed peer's account history window", async () => {
    const history = await vi.importActual<typeof import("./history.js")>("./history.js");
    getHistoryLimitFromSessionKeyMock.mockImplementationOnce(history.getHistoryLimitFromSessionKey);
    limitHistoryTurnsMock.mockImplementationOnce(history.limitHistoryTurns);
    attemptServerEndpointCompactionMock.mockImplementationOnce(async (input) =>
      serverEndpointCompaction(input),
    );
    const sessionKey = "agent:main:telegram:direct:direct:peer";
    const sessionTarget = {
      ...wrappedCompactionArgs().sessionTarget,
      sessionId: "routed-peer-session",
      sessionKey,
    };
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: sessionTarget.sessionId,
      updatedAt: 1,
    });
    sessionMessages.splice(
      0,
      sessionMessages.length,
      ...Array.from({ length: 6 }, (_, index) => ({
        role: "user",
        content: `turn-${index + 1}`,
        timestamp: index + 1,
      })),
    );
    await compactDirect({
      sessionId: sessionTarget.sessionId,
      sessionKey,
      sessionTarget,
      agentAccountId: "direct",
      conversationRoutePeerId: "123",
      chatType: "direct",
      config: {
        session: { identityLinks: { "direct:peer": ["telegram:123"] } },
        channels: {
          telegram: {
            dmHistoryLimit: 20,
            accounts: {
              direct: {
                dmHistoryLimit: 10,
                dms: { "direct:peer": { historyLimit: 2 }, peer: { historyLimit: 6 } },
              },
            },
          },
        },
      },
    });
    expect(attemptServerEndpointCompactionMock).toHaveBeenCalledOnce();
    expectCall(attemptServerEndpointCompactionMock, {
      context: expect.objectContaining({
        messages: [
          { role: "user", content: "turn-5", timestamp: 5 },
          { role: "user", content: "turn-6", timestamp: 6 },
        ],
      }),
    });
  });
  it("cancels direct compaction while prepared runtime admission is waiting", async () => {
    const controller = new AbortController();
    const started = createDeferred();
    const resume = createDeferred();
    const acquire = expectDefined(
      acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
      "prepared runtime acquisition",
    );
    acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce(async (input, options) => {
      started.resolve();
      await racePromiseWithAbortSignal(resume.promise, options?.abortSignal);
      return await acquire(input, options);
    });
    const pending = compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ abortSignal: controller.signal }),
    );
    const stopped = pending.then(
      () => "completed",
      (error: unknown) => error,
    );
    try {
      await started.promise;
      const reason = new Error("direct compaction cancelled during admission");
      controller.abort(reason);
      // Releasing admission after cancellation must never enter model/session preparation.
      resume.resolve();
      expect(await stopped).toMatchObject({ name: "AbortError", cause: reason });
      expect(resolveModelAsyncMock).not.toHaveBeenCalled();
      expect(createAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await stopped;
    }
  });

  it("refreshes the delegated watchdog before post-compaction hooks", async () => {
    const compactionTimeoutReset = vi.fn();
    hookRunner.hasHooks.mockImplementation((name?: string) => name === "after_compaction");
    hookRunner.runAfterCompaction.mockImplementationOnce(async () => {
      expect(compactionTimeoutReset).toHaveBeenCalledTimes(3);
    });

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ compactionTimeoutReset }),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(hookRunner.runAfterCompaction).toHaveBeenCalledOnce();
  });

  it("refreshes the delegated watchdog before delayed fallback setup", async () => {
    const compactionTimeoutReset = vi.fn();
    const fallbackSetupStarted = createDeferred<number>();
    const fallbackSetupReleased = createDeferred();
    const createAgentSession = expectDefined(
      createAgentSessionMock.getMockImplementation(),
      "session factory",
    );
    createAgentSessionMock.mockImplementation(async (...args) => {
      if (createAgentSessionMock.mock.calls.length === 2) {
        fallbackSetupStarted.resolve(compactionTimeoutReset.mock.calls.length);
        await fallbackSetupReleased.promise;
      }
      return await createAgentSession(...args);
    });
    sessionCompactImpl
      .mockRejectedValueOnce(new Error("Reasoning is mandatory for this endpoint"))
      .mockResolvedValueOnce(compactionSummary("fallback summary", "entry-fallback"));

    const pending = compactDirect({ compactionTimeoutReset, thinkLevel: "off" });
    try {
      expect(await fallbackSetupStarted.promise).toBe(3);
    } finally {
      fallbackSetupReleased.resolve(undefined);
      await pending;
    }

    await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
    expect(createAgentSessionMock).toHaveBeenCalledTimes(2);
    expect(compactionTimeoutReset).toHaveBeenCalledTimes(6);
  });

  it("preserves timeouts after summary generation", async () => {
    const createAgentSession = expectDefined(
      createAgentSessionMock.getMockImplementation(),
      "session factory",
    );
    const policies: unknown[] = [];
    const entered = createDeferred();
    createAgentSessionMock.mockImplementation(async (...args) => {
      const created = await createAgentSession(...args);
      // The summary is ready; persistence then outlives the watchdog.
      created.session[agentSessionAutomaticCompaction] = vi.fn(
        async (_instructions, _state, policy, options?: { onSummaryReady?: () => void }) => {
          policies.push(policy);
          options?.onSummaryReady?.();
          entered.resolve(undefined);
          return await createDeferred<never>().promise;
        },
      );
      return created;
    });
    vi.useFakeTimers();
    try {
      const pending = compactDirect({ trigger: "budget" });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(181_000);

      await expect(pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: expect.stringContaining("timed out"),
      });
      expect(policies).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects generic compaction of a native-locked session", async () => {
    const params = await nativeCompactionArgs(codexArgs({ model: "gpt-5.6-luna" }));
    const result = await compactEmbeddedAgentSessionDirect({
      ...params,
      agentHarnessId: "openclaw",
      sessionEntry: { sessionId: TEST_SESSION_ID, updatedAt: 1, pluginOwnerId: "stale-owner" },
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      failure: { reason: "model_selection_locked" },
    });
    expectNoCalls(resolveModelMock, sessionCompactImpl);
  });

  it.each(["prepared runtime plan", "source-provider auth profile"] as const)(
    "discards the %s when compaction falls back across providers",
    async (source) => {
      const preparedPlan = source === "prepared runtime plan";
      const { runtimeAuthPlan, runtimePlan } = createPreparedCodexCompactionPlans();
      sessionCompactImpl.mockRejectedValueOnce(rateLimited());
      if (preparedPlan) {
        sessionCompactImpl.mockResolvedValueOnce(
          compactionSummary("rebuilt fallback summary", "entry-fallback"),
        );
      }
      const result = await compactDirect({
        provider: "openai",
        model: "gpt-5.5",
        ...(preparedPlan
          ? {
              modelFallbacksOverride: ["anthropic/claude-fallback"],
              runtimeAuthPlan,
              runtimePlan,
            }
          : {
              authProfileId: "openai:test",
              runtimeAuthPlan: {
                providerForAuth: "openai",
                modelId: "gpt-5.5",
                authProfileProviderForAuth: "openai",
                forwardedAuthProfileId: "openai:test",
              },
              config: defaultsConfig({
                model: { primary: "openai/gpt-5.5", fallbacks: ["github-copilot/gpt-5.6-sol"] },
              }),
            }),
      });
      if (preparedPlan) {
        expect(result).toMatchObject({ ok: true, result: { summary: "rebuilt fallback summary" } });
        const fallbackPlanCall = findMockCall(buildAgentRuntimePlanMock, ([input]) => {
          const fields = input as { provider?: string; modelId?: string } | undefined;
          return fields?.provider === "anthropic" && fields.modelId === "claude-fallback";
        });
        expectRecordFields(fallbackPlanCall[0], {
          provider: "anthropic",
          modelId: "claude-fallback",
          harnessId: "openclaw",
          modelRoute: undefined,
        });
      } else {
        expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
        const targetResolveCall = resolveModelAsyncMock.mock.calls.find(
          ([provider]) => provider === "github-copilot",
        );
        expect(targetResolveCall).toBeDefined();
        expect(targetResolveCall?.[4]?.authProfileId).toBeUndefined();
        expectRecordFields(resolveEmbeddedAgentStreamMock.mock.lastCall?.[0], {
          authProfileId: undefined,
        });
      }
    },
  );

  it("rematerializes the downstream model for a resolved backup profile", async () => {
    getApiKeyForModelMock
      .mockRejectedValueOnce(new Error("missing SecretRef"))
      .mockResolvedValueOnce({
        apiKey: "backup-key",
        mode: "api-key",
        source: "profile:openai:backup",
        profileId: "openai:backup",
      });

    await compactDirect({
      provider: "openai",
      model: "gpt-5.5",
      runtimeAuthPlan: {
        providerForAuth: "openai",
        modelId: "gpt-5.5",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:missing",
        forwardedAuthProfileSource: "auto",
        forwardedAuthProfileCandidateIds: ["openai:missing", "openai:backup"],
        selectedAuthMode: "api-key",
      },
    });

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([params]) => (params as { profileId?: string }).profileId,
      ),
    ).toEqual(["openai:missing", "openai:backup"]);
    expect(resolveModelAsyncMock.mock.calls.map((call) => call[4])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authProfileId: "openai:backup" }),
        expect.objectContaining({ authProfileId: "openai:missing" }),
      ]),
    );
    expectCall(resolveEmbeddedAgentStreamMock, { authProfileId: "openai:backup" });
    expectCall(buildAgentRuntimePlanMock, { sessionAuthProfileId: "openai:backup" });
  });

  it("isolates sandbox policy without host session reads", async () => {
    const { addSession, deleteSession } = await import("../bash-process-registry.js");
    const { resolveSandboxContext } = await import("../sandbox/context.js");
    const owned = createProcessSessionFixture({ id: "compaction-owned", backgrounded: true });
    owned.scopeKey = TEST_SESSION_KEY;
    const other = createProcessSessionFixture({ id: "policy-owned", backgrounded: true });
    other.scopeKey = "agent:main:telegram:default:direct:12345";
    addSession(owned);
    addSession(other);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: other.scopeKey, storePath: TEST_STORE_PATH },
      { sessionId: "policy-owned", updatedAt: 1, sandboxMode: "off" },
    );
    const sandboxQueries: string[] = [];
    resolveSandboxContextMock.mockImplementationOnce(async (params) => {
      const sql = observeHostDataSql();
      try {
        return await resolveSandboxContext(params);
      } finally {
        sandboxQueries.push(...sql.queries);
        sql.restore();
      }
    });
    try {
      await compactWorkspace({
        sessionKey: owned.scopeKey,
        sandboxSessionKey: other.scopeKey,
        config: {
          session: { store: TEST_STORE_PATH },
          agents: { defaults: { sandbox: { mode: "all" } } },
        },
      });

      expectCall(resolveSandboxContextMock, {
        sessionKey: other.scopeKey,
        workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
      });
      expect(sandboxQueries).toEqual([]);
      expectCall(buildConfiguredAgentSystemPromptMock, {
        runtimeInfo: expect.objectContaining({
          activeProcessSessions: [expect.objectContaining({ sessionId: owned.id })],
        }),
      });
    } finally {
      deleteSession(owned.id);
      deleteSession(other.id);
    }
  });

  it.each([
    ["agent:main:subagent:worker", "subagent", "minimal", "Subagent compact command guidance."],
    ["agent:codex:acp:worker", "acp_backend", "full", "ACP compact command guidance."],
  ] as const)(
    "rebuilds the %s prompt with its guidance",
    async (sessionKey, promptSurface, promptMode, guidance) => {
      const runtimeCwd = join(TEST_WORKSPACE_DIR, "task-repo");
      await compactWorkspace({ sessionKey, cwd: runtimeCwd });
      expect(listRegisteredPluginAgentPromptGuidanceMock).toHaveBeenCalledWith({
        surface: promptSurface,
      });
      expectCall(buildConfiguredAgentSystemPromptMock, {
        promptMode,
        promptSurface,
        runtimeCwd,
        workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
        nativeCommandGuidanceLines: [guidance],
      });
    },
  );

  it.each([false, true])(
    "renders the compaction bootstrap notice only for omitted files (%s)",
    async (omitted) => {
      const file = {
        name: "AGENTS.md" as const,
        path: "/ws/AGENTS.md",
        content: "a".repeat(100),
        missing: false,
      };
      resolveBootstrapContextForRunMock.mockResolvedValueOnce({
        bootstrapFiles: omitted
          ? [
              file,
              { ...file, name: "IDENTITY.md", path: "/ws/IDENTITY.md", content: "b".repeat(100) },
            ]
          : [file],
        contextFiles: [{ path: file.path, content: file.content }],
      });
      const actual = await vi.importActual<typeof import("../system-prompt-config.js")>(
        "../system-prompt-config.js",
      );
      buildConfiguredAgentSystemPromptMock.mockImplementation(
        actual.buildConfiguredAgentSystemPrompt,
      );
      await compactEmbeddedAgentSessionDirect(directCompactionArgs());
      const created = (await createAgentSessionMock.mock.results[0]?.value) as {
        session: { agent: { state: { systemPrompt?: string } }; setBaseSystemPrompt: Mock };
      };
      const prompt = created.session.agent.state.systemPrompt ?? "";
      expect(prompt.includes("## Bootstrap Context Notice")).toBe(omitted);
      expect(prompt.includes("Treat Project Context as partial")).toBe(omitted);
      expect(created.session.setBaseSystemPrompt).toHaveBeenCalledWith(prompt);
    },
  );

  it.each([
    { execMode: "deny", permissionMode: "read-only", expectedExecMode: "deny", rootless: false },
    { execMode: "allowlist", permissionMode: "guarded", expectedExecMode: "ask", rootless: false },
    { execMode: "full", permissionMode: "full", expectedExecMode: "full", rootless: false },
    { execMode: undefined, permissionMode: "workspace", expectedExecMode: "auto", rootless: true },
  ] as const)(
    "uses the final $permissionMode permission policy for compaction tools",
    async ({ execMode, permissionMode, expectedExecMode, rootless }) => {
      const workspaceDir = rootless
        ? compactionFixture.makeTempDir("openclaw-rootless-compaction-permission-")
        : join(TEST_WORKSPACE_DIR, "workspace");
      const root = rootless ? await realpath(workspaceDir) : workspaceDir;
      await compactDirect({
        workspaceDir,
        requireWorkspaceOnly: rootless || undefined,
        permissionMode: rootless ? "workspace" : "full",
        sessionRoot: rootless ? undefined : root,
        execOverrides: execMode ? { mode: execMode } : undefined,
        sessionEntry: {
          sessionId: TEST_SESSION_ID,
          permissionMode: rootless ? "workspace" : "full",
          sessionRoot: rootless ? undefined : root,
        },
      });

      const toolOptions = expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
        sessionPermissionPolicy: {
          mode: permissionMode,
          root,
        },
      });
      expect(toolOptions.exec).toEqual(expect.objectContaining({ mode: expectedExecMode }));
      if (rootless) {
        expect(toolOptions.requireWorkspaceOnly).toBe(true);
      }
    },
  );

  it("keeps manifest-profiled plugin tools executable during compaction", async () => {
    const toolName = "profiled_plugin_tool";
    const metadataSnapshot = {
      ...createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "profiled-plugin",
            origin: "workspace",
            rootDir: join(TEST_WORKSPACE_DIR, "workspace/profiled-plugin"),
            contracts: { tools: [toolName] },
            toolMetadata: { [toolName]: { profiles: ["coding"] } },
          },
        ],
      }),
      workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
    };
    const preparedModelRuntime = createCompactHooksPreparedModelRuntime({
      agentId: "main",
      agentDir: join(TEST_WORKSPACE_DIR, "agents/main/agent"),
      config: { tools: { profile: "coding" } },
      workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
      metadataSnapshot,
    }) as never;
    acquireAgentRunPreparedModelRuntimeMock.mockResolvedValueOnce({
      snapshot: preparedModelRuntime,
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    });
    createOpenClawCodingToolsMock.mockReturnValueOnce([
      compactionTool(toolName, {
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      }),
    ] as never);

    const result = await compactWorkspace({ config: { tools: { profile: "coding" } } });

    expect(result.ok).toBe(true);
    const toolOptions = mockCallArg(createOpenClawCodingToolsMock) as {
      preparedModelRuntime: { metadataSnapshot: unknown };
    };
    expect(toolOptions.preparedModelRuntime.metadataSnapshot).toBe(metadataSnapshot);
    expect(toolOptions).toMatchObject({
      conversationCapabilityProfile: {
        policy: { explicitToolAllowlist: expect.arrayContaining([toolName]) },
      },
    });
    expect(mockCallArg(createAgentSessionMock)).toMatchObject({
      tools: expect.arrayContaining([toolName]),
      customTools: expect.arrayContaining([expect.objectContaining({ name: toolName })]),
    });
  });

  it("skips tools for models without tool support", async () => {
    mockResolvedModel(false);

    await compactWorkspace();

    expect(createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("quarantines unsupported tool schemas before session creation", async () => {
    mockContextEngine(false, true);
    resolveModelMock.mockImplementationOnce((provider = "openai", modelId = "fake") => ({
      ...createCompactHooksResolvedModel(provider, modelId),
      model: { provider: "openai", api: "openai-responses", id: "fake", input: [] },
    }));
    createOpenClawCodingToolsMock.mockReturnValueOnce([
      compactionTool("healthy_lookup", {
        execute: async () => ({ text: "ok" }),
      }),
      compactionTool("fuzzplugin_move_angles", {
        parameters: { type: "array", items: { type: "number" } },
        execute: async () => ({ text: "bad" }),
      }),
    ] as never);

    await compactWorkspace({ runId: "run-tool-schema-quarantine" });

    expect(mockCallArg(createAgentSessionMock)).toMatchObject({
      customTools: [expect.objectContaining({ name: "healthy_lookup" })],
      tools: ["healthy_lookup"],
    });
  });

  it("preserves configured fallback identity through credential refresh", async () => {
    const provider = "compaction-fallback-fixture";
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: provider,
          providers: [provider],
          modelIdNormalization: {
            providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
          },
        },
      ],
    });
    const { normalizeStaticProviderModelId } =
      await vi.importActual<typeof import("../model-ref-shared.js")>("../model-ref-shared.js");
    const { shouldPreferProviderRuntimeResolvedModel } =
      await import("../../plugins/provider-runtime.js");
    const acquire = expectDefined(
      acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
      "prepared runtime fixture",
    );
    const resolveModel = expectDefined(
      resolveModelAsyncMock.getMockImplementation(),
      "model resolver fixture",
    );
    const preferRuntime = expectDefined(
      vi.mocked(shouldPreferProviderRuntimeResolvedModel).getMockImplementation(),
      "runtime metadata fixture",
    );
    const materializedModels: string[] = [];
    acquireAgentRunPreparedModelRuntimeMock.mockImplementation(async (...args) => {
      const lease = await acquire(...args);
      return {
        ...lease,
        snapshot: {
          ...lease.snapshot,
          metadataSnapshot: { ...metadataSnapshot, workspaceDir: lease.snapshot.workspaceDir },
        },
      };
    });
    // Model the resolver's raw-input contract with the real captured alias policy.
    resolveModelAsyncMock.mockImplementation(
      async (providerId, modelId, agentDir, config, options) => {
        const resolvedId =
          options?.modelIdSource === "selected"
            ? modelId
            : normalizeStaticProviderModelId(providerId, modelId, {
                manifestPlugins: metadataSnapshot,
              });
        materializedModels.push(resolvedId);
        return resolveModel(providerId, resolvedId, agentDir, config, options);
      },
    );
    vi.mocked(shouldPreferProviderRuntimeResolvedModel).mockImplementation(
      ({ provider: candidateProvider }) => candidateProvider === provider,
    );
    resolveProviderEntryApiKeyProfileReferenceMock.mockReturnValue({ kind: "literal" });
    sessionCompactImpl
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(compactionSummary("overflow fallback summary", "entry-fallback"));
    try {
      const result = await compactDirect({
        provider,
        model: "primary",
        trigger: "overflow",
        modelFallbacksOverride: [`${provider}/entry`],
        config: {
          ...defaultsConfig({ model: { primary: `${provider}/primary`, fallbacks: [] } }),
          ...providerConfig(provider, {
            auth: "api-key",
            apiKey: "synthetic-fixture",
            baseUrl: "http://127.0.0.1:1/v1",
            models: [],
          }),
        },
      });
      expect(result, result.reason).toMatchObject({
        ok: true,
        result: { summary: "overflow fallback summary" },
      });
      expect(createAgentSessionMock.mock.calls.map(([input]) => input)).toMatchObject([
        { model: { id: "primary" } },
        { model: { id: "middle" } },
      ]);
      expect(materializedModels).not.toContain("final");
      expect(
        materializedModels.filter((model) => model === "middle").length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      acquireAgentRunPreparedModelRuntimeMock.mockImplementation(acquire);
      resolveModelAsyncMock.mockImplementation(resolveModel);
      vi.mocked(shouldPreferProviderRuntimeResolvedModel).mockImplementation(preferRuntime);
    }
  });

  registerCompactionSafeguardTests({
    compactEmbeddedAgentSessionDirect: (params) => compactEmbeddedAgentSessionDirect(params),
    wrappedCompactionArgs,
    getWorkspaceDir: () => TEST_WORKSPACE_DIR,
  });

  describe("progress-aware compaction watchdog", () => {
    registerAgentSessionLoopTestLifecycle();
    // The harness resolves every compaction watchdog to 30 s.
    const windowMs = 30_000;
    const ceilingMs = 10 * windowMs;
    const summaryCutoffMs = ceilingMs - windowMs;
    const deltaEveryMs = 20_000;

    // Real watchdog/delegate/session/summarizer; only the provider stream is scripted.
    // prepMs starts the host watchdog before the summary watchdog.
    async function compactWhileStreaming(
      deltas: number,
      end: "done" | "silent" | "keepalive",
      opts: { trigger?: "budget"; prepMs?: number } = {},
    ) {
      const [{ createAgentSession }, { guardSessionManager }, { resolveEmbeddedAgentStream }] =
        await Promise.all([
          import("../sessions/sdk.js"),
          import("../session-tool-result-guard-wrapper.js"),
          import("./stream-resolution.js"),
        ]);
      const sessionManager = SessionManager.inMemory(TEST_WORKSPACE_DIR);
      for (const content of ["Review the checklist.", "Compare options.", "Keep the notes."]) {
        sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
      }
      const streamStarted = createDeferred();
      const stream = vi.fn<StreamFn>((activeModel, _context, options) => {
        const events = createAssistantMessageEventStream();
        let sent = 0;
        const timer = setInterval(() => {
          if (sent < deltas) {
            sent += 1;
            events.push({ type: "text_delta", contentIndex: 0, delta: "Kept the notes. " });
            return;
          }
          if (end === "keepalive") {
            events.push({ type: "text_delta", contentIndex: 0, delta: "" });
            return;
          }
          clearInterval(timer);
          if (end === "done") {
            const text = "Kept the checklist, options and notes.";
            const message = createAssistant(activeModel, [{ type: "text", text }]);
            events.push({ type: "done", reason: "stop", message });
            events.end();
          }
        }, deltaEveryMs);
        options?.signal?.addEventListener(
          "abort",
          () => {
            clearInterval(timer);
            const error = createAssistant(activeModel, [], "aborted");
            events.push({ type: "error", reason: "aborted", error });
            events.end();
          },
          { once: true },
        );
        streamStarted.resolve();
        return events;
      });
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
        streamFn: stream,
        strategy: "session-custom",
      });
      const prepStarted = createDeferred();
      vi.mocked(createAgentSession).mockImplementation(async ({ model }) => {
        if (!model) {
          throw new Error("Expected the prepared compaction model");
        }
        if (opts.prepMs) {
          const prepared = Promise.withResolvers<void>();
          setTimeout(prepared.resolve, opts.prepMs);
          prepStarted.resolve();
          await prepared.promise;
        }
        return await createTestSession({
          model: { ...testModel, ...model },
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
          resourceLoader: await createResourceLoader(),
        });
      });
      mockDelegatingEngine();

      vi.useFakeTimers();
      let settled = false;
      const pending = compactQueued(opts.trigger ? { trigger: opts.trigger } : {}).finally(() => {
        settled = true;
      });
      void pending.catch(() => undefined);
      if (opts.prepMs) {
        await prepStarted.promise;
        await vi.advanceTimersByTimeAsync(opts.prepMs);
      }
      await streamStarted.promise;
      return { pending, stream, sessionManager, settled: () => settled };
    }

    afterEach(() => vi.useRealTimers());

    it("keeps a request alive while it streams for longer than the window", async () => {
      const run = await compactWhileStreaming(10, "done");
      await vi.advanceTimersByTimeAsync(11 * deltaEveryMs);

      await expect(run.pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(run.stream).toHaveBeenCalledOnce();
    });

    it.each([
      ["inactivity despite empty keepalives", 5, "keepalive", 0, 5 * deltaEveryMs + windowMs],
      [
        "operation ceiling despite continuous output",
        Infinity,
        "done",
        5_000,
        summaryCutoffMs - 5_000,
      ],
    ] as const)("stops at the %s boundary", async (_boundary, deltas, end, prepMs, elapsed) => {
      const run = await compactWhileStreaming(deltas, end, { prepMs });
      await vi.advanceTimersByTimeAsync(elapsed - 1);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(run.pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: expect.stringContaining("timed out"),
      });
      expect(run.stream).toHaveBeenCalledOnce();
    });

    // #164246: automatic summary timeouts still commit deterministic reduction.
    it("commits automatic reduction at the operation ceiling", async () => {
      const prepMs = 5_000;
      const run = await compactWhileStreaming(Number.POSITIVE_INFINITY, "done", {
        trigger: "budget",
        prepMs,
      });
      await vi.advanceTimersByTimeAsync(summaryCutoffMs - prepMs);

      await expect(run.pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(
        run.sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
      ).toMatchObject({ summary: expect.stringContaining("removed without a summary") });
      expect(run.stream).toHaveBeenCalledOnce();
    });
  });

  it("plans canonical fallback plugins from the configured alias", async () => {
    const config: OpenClawConfig = defaultsConfig({
      models: { "anthropic/claude-fallback": { alias: "summary-backup" } },
    });
    const result = await compactDirect({
      provider: "openai",
      model: "gpt-primary",
      agentHarnessId: "codex",
      modelFallbacksOverride: ["summary-backup"],
      config,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(plannedCompactionPluginSelections(config)).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-fallback",
        runtime: "codex",
      }),
    );
    const admittedConfig = defaultsConfig({
      ...config.agents?.defaults,
      compaction: { model: "anthropic/reloaded-summary" },
    });
    expect(plannedCompactionPluginSelections(admittedConfig)).toContainEqual(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "reloaded-summary",
        runtime: "codex",
      }),
    );
  });

  it("revalidates immutable Ultra for each fallback", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
    sessionCompactImpl
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(compactionSummary("fallback summary", "entry-fallback"));
    const params = {
      ...directCompactionArgs(),
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: "ultra" as const,
      trigger: "overflow" as const,
      modelFallbacksOverride: ["demo/basic"],
      config: defaultsConfig({
        compaction: { thinkingLevel: "inherit" as const },
        models: {
          "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
        },
      }),
    };

    const result = await compactEmbeddedAgentSessionDirect(params);

    expect(result.ok).toBe(true);
    expect(
      createAgentSessionMock.mock.calls.map(
        (call) => (call[0] as { thinkingLevel?: string }).thinkingLevel,
      ),
    ).toEqual(["max", "high"]);
    expect(params.thinkLevel).toBe("ultra");
  });

  it("preserves Codex OAuth across OpenAI fallbacks", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:default"] },
    });
    getApiKeyForModelMock.mockImplementation(async (params?: { profileId?: string }) => ({
      apiKey: "test-oauth",
      mode: "oauth",
      source: `profile:${params?.profileId ?? "openai:default"}`,
      profileId: params?.profileId ?? "openai:default",
    }));
    sessionCompactImpl
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(compactionSummary("oauth fallback summary", "entry-fallback"));

    const result = await compactWorkspace({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:default",
      trigger: "overflow",
      modelFallbacksOverride: ["openai/gpt-5.4-mini"],
      config: defaultsConfig({ model: { primary: "openai/gpt-5.5", fallbacks: [] } }) as never,
    });

    expect(result).toMatchObject({ ok: true, result: { summary: "oauth fallback summary" } });
    findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-5.5",
    );
    findMockCall(
      resolveModelMock,
      ([provider, modelId]) => provider === "openai" && modelId === "gpt-5.4-mini",
    );
    expectRecordFields(mockCallArg(resolveEmbeddedAgentStreamMock, 1), {
      authProfileId: "openai:default",
    });
  });

  it("forwards internal compaction hook messages to the caller", async () => {
    const onHookMessages = vi.fn();
    triggerInternalHookMock.mockImplementation((event: unknown) => {
      const hookEvent = event as { action?: string; messages?: string[] };
      hookEvent.messages?.push(`${hookEvent.action} notice`);
    });
    await compactDirect({ onCompactionHookMessages: onHookMessages });

    for (const [index, phase] of ["before", "after"].entries()) {
      expect(onHookMessages).toHaveBeenNthCalledWith(index + 1, {
        phase,
        messages: [`compact:${phase} notice`],
        sessionId: TEST_SESSION_ID,
        sessionKey: TEST_SESSION_KEY,
      });
    }
  });
  it("treats pre-compaction token estimation failures as a no-op sanity check", () => {
    estimateTokensMock.mockImplementation((message: unknown) => {
      const role = (message as { role?: string }).role;
      if (role === "assistant") {
        throw new Error("legacy message");
      }
      if (role === "user") {
        return 30;
      }
      return 5;
    });
    const beforeMetrics = compactTesting.buildBeforeCompactionHookMetrics({
      originalMessages: sessionMessages as AgentMessage[],
      currentMessages: sessionMessages as AgentMessage[],
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });
    const tokensAfter = compactTesting.estimateTokensAfterCompaction({
      messagesAfter: [{ role: "user", content: "kept ask" }] as AgentMessage[],
      fullSessionTokensBefore: 0,
      estimateTokensFn: estimateTokensMock as (message: AgentMessage) => number,
    });

    expect(beforeMetrics).toMatchObject({
      tokenCountOriginal: undefined,
      tokenCountBefore: undefined,
    });
    expect(tokensAfter).toBe(30);
  });

  it("skips sync in await mode when postCompactionForce is false", async () => {
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });
    resolveMemorySearchConfigMock.mockReturnValue({
      sources: ["sessions"],
      sync: {
        sessions: {
          postCompactionForce: false,
        },
      },
    });

    await compactTesting.runPostCompactionSideEffects({
      config: compactionConfig("await"),
      sessionKey: TEST_SESSION_KEY,
      sessionFile: TEST_SESSION_FILE,
    });

    const resolveAgentArg = mockCallArg(resolveSessionAgentIdMock);
    if (typeof resolveAgentArg !== "object" || resolveAgentArg === null) {
      throw new Error("Expected session agent arguments");
    }
    expect(resolveAgentArg).toMatchObject({ sessionKey: TEST_SESSION_KEY });
    expect(Reflect.get(resolveAgentArg, "config")).toBeTypeOf("object");
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  registerDirectProviderRefreshTests({
    compactTesting: () => compactTesting,
    compactionConfig,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: () => TEST_SESSION_FILE,
  });
  it("carries the prepared provider reconciler into direct compaction", async () => {
    const reconcile = vi.fn(async () => undefined);
    const { resolvePreparedProviderRuntimeHandle } = await import("../runtime-plan/build.js");
    vi.mocked(resolvePreparedProviderRuntimeHandle).mockImplementationOnce((params) => ({
      provider: params.provider,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      prepared: true,
      plugin: { id: params.provider, label: "Fixture", auth: [], reconcileLocalService: reconcile },
    }));

    await expect(compactDirect()).resolves.toMatchObject({ ok: true });

    const streamRegistration = mockCallArg(registerProviderStreamForModelMock) as {
      model: object;
    };
    expect(getModelProviderLocalServiceReconciler(streamRegistration.model)).toBe(reconcile);
    expect(getModelProviderRuntimePluginHandle(streamRegistration.model)).toBe(
      buildAgentRuntimePlanMock.mock.calls[0]?.[0].providerRuntimeHandle,
    );
  });
  it("compacts an overflow transcript anchored by a compaction summary", async () => {
    sessionMessages.splice(
      0,
      sessionMessages.length,
      {
        role: "compactionSummary",
        summary: "The user asked for a long-running repository audit.",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "exec", arguments: {} }],
        timestamp: 2,
      },
      makeTextToolResult("call-1", "exec", "audit output", false, 3),
    );

    const result = await compactDirect({ trigger: "overflow" });

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionCompactImpl).toHaveBeenCalledOnce();
  });

  it("never falls back from an explicit compaction.model", async () => {
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid request body"), { status: 400 }),
    );

    const result = await compactWorkspace({
      provider: "openai",
      model: "gpt-primary",
      config: defaultsConfig({
        model: {
          primary: "openai/gpt-primary",
          fallbacks: ["anthropic/claude-fallback"],
        },
        compaction: { model: "azure/compact-primary" },
      }) as never,
    });

    expect(result.ok).toBe(false);
    expect(resolveModelMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(resolveModelMock)).toBe("azure");
    expect(mockCallArg(resolveModelMock, 0, 1)).toBe("compact-primary");
    expect(mockCallArg(resolveModelMock, 0, 2)).toBeTypeOf("string");
    if (mockCallArg(resolveModelMock, 0, 3) === undefined) {
      throw new Error("Expected resolve-model options");
    }
  });
});

describe("compactEmbeddedAgentSession hooks (ownsCompaction engine)", () => {
  function nativeCliArgs(overrides: Record<string, unknown> = {}) {
    resolveCliBackendConfigMock.mockReturnValue({
      ownsNativeCompaction: true,
      manualCompaction: { buildPrompt: () => "/compact" },
    });
    return wrappedCompactionArgs({
      agentDir: TEST_WORKSPACE_DIR,
      trigger: "manual",
      provider: "anthropic",
      model: "opus",
      agentHarnessId: "claude-cli",
      cliSessionId: "native-session",
      ...overrides,
    });
  }

  beforeEach(() => mockResolvedModel(undefined, true));

  registerQueuedProviderRefreshTest({
    compact: () => compactEmbeddedAgentSession,
    wrappedArgs: wrappedCompactionArgs,
    compactionConfig,
    sessionKey: TEST_SESSION_KEY,
    sessionId: () => TEST_SESSION_ID,
  });

  it.each([
    ["native", "session"],
    ["context-engine", "global"],
    ["context-engine", "injected"],
  ] as const)("cancels %s compaction before the %s queue admits it", async (route, blocked) => {
    const queue = await vi.importActual<typeof import("../../process/command-queue.js")>(
      "../../process/command-queue.js",
    );
    const controller = new AbortController();
    const queued = createDeferred();
    const release = createDeferred();
    const globalLane = `compaction-test:${route}:${blocked}`;
    const blockedLane =
      blocked === "session"
        ? "test-session-lane"
        : blocked === "global"
          ? "test-global-lane"
          : globalLane;
    const admission = await import("../../sessions/session-controller.admission.js");
    const admit = admission.withSessionTurn;
    const started = createDeferred();
    const blocker =
      blocked === "session"
        ? admit(wrappedCompactionArgs(), async () => {
            started.resolve();
            await release.promise;
          })
        : queue.enqueueCommandInLane(blockedLane, () => release.promise);
    if (blocked === "session") {
      await started.promise;
    }
    const admissionSpy =
      blocked === "session"
        ? vi
            .spyOn(admission, "withSessionTurn")
            .mockImplementation(
              <T>(
                params: SessionTurnAdmission,
                run: (operation: ReplyOperation | undefined, signal: AbortSignal) => Promise<T>,
              ) => {
                const pending = admit(params, run);
                queued.resolve();
                return pending;
              },
            )
        : undefined;
    const enqueue = <T>(
      lane: string,
      task: () => T | Promise<T>,
      options?: CommandQueueEnqueueOptions,
    ) =>
      queue.enqueueCommandInLane(lane, async () => task(), {
        ...options,
        onQueued: () => {
          options?.onQueued?.();
          if (lane === blockedLane) {
            queued.resolve();
          }
        },
      });
    enqueueCommandInLaneMock.mockImplementation(
      (lane, task, ...[options]: [CommandQueueEnqueueOptions?]) =>
        enqueue(String(lane), task, options),
    );
    const overrides = {
      abortSignal: controller.signal,
      lane: globalLane,
      enqueue:
        blocked === "injected"
          ? <T>(task: () => Promise<T>, options?: CommandQueueEnqueueOptions) =>
              enqueue(globalLane, task, options)
          : undefined,
    };
    if (route === "native") {
      mockContextEngine(false);
      maybeCompactAgentHarnessSessionMock.mockResolvedValue({ ok: true, compacted: false });
    }
    const params =
      route === "native"
        ? await nativeCompactionArgs(codexArgs(overrides))
        : wrappedCompactionArgs(overrides);
    const pending = compactEmbeddedAgentSession(params);
    try {
      await Promise.race([
        queued.promise,
        pending.then((result) => {
          throw new Error(
            `Compaction did not reach its blocked queue: ${JSON.stringify({ result, lanes: enqueueCommandInLaneMock.mock.calls.map((call) => call[0]) })}`,
          );
        }),
      ]);
      expectNoCalls(contextEngineCompactMock, maybeCompactAgentHarnessSessionMock);
      controller.abort(new Error("Foreground turn preempted queued maintenance"));
      if (blocked !== "session") {
        expect(queue.getCommandLaneSnapshot(blockedLane).queuedCount).toBe(0);
      }
      await expect(pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "compaction aborted",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, pending]);
      admissionSpy?.mockRestore();
    }
    expectNoCalls(contextEngineCompactMock, maybeCompactAgentHarnessSessionMock);
  });

  it("drains committed maintenance before reporting a failed manual request pinned to its predecessor", async () => {
    const { acceptCompactionSuccessor } = await import("./compaction-successor.js");
    const params = wrappedCompactionArgs({ trigger: "manual" });
    const predecessor = expectDefined(
      loadSessionEntryReadOnly(params.sessionTarget),
      "predecessor",
    );
    const successorTarget = { ...params.sessionTarget, sessionId: "maintenance-successor" };
    const owner = createSessionMaintenanceOwner({
      sessionKey: TEST_SESSION_KEY,
      preemptible: true,
    });
    const committed = createDeferred();
    const interrupted = createDeferred();
    const releaseCleanup = createDeferred();
    const events: string[] = [];
    owner.signal.addEventListener("abort", () => interrupted.resolve(), { once: true });
    const maintenance = owner.track(
      owner.run(async () => {
        await acceptCompactionSuccessor({
          currentTarget: params.sessionTarget,
          expectedEntry: {
            sessionId: predecessor.sessionId,
            lifecycleRevision: predecessor.lifecycleRevision,
            activeWriterRunId: predecessor.activeWriterRunId,
          },
          assertActive: owner.assertCurrent,
          result: {
            ok: true,
            compacted: true,
            result: { sessionTarget: successorTarget, tokensBefore: 90_000, tokensAfter: 100 },
          },
        });
        SessionManager.open(successorTarget).appendMessage({
          role: "user",
          content: [{ type: "text", text: "Retain this successor history." }],
          timestamp: 1,
        });
        committed.resolve();
        await releaseCleanup.promise;
        events.push("maintenance cleanup finished");
      }),
    );
    await Promise.race([committed.promise, maintenance]);
    const transcriptBefore = await loadTranscriptEvents(successorTarget);
    const acceptedEntry = loadSessionEntryReadOnly(successorTarget);
    const pending = compactEmbeddedAgentSession(params);
    const settled = pending.then(
      () => events.push("manual resolved"),
      () => events.push("manual rejected"),
    );
    try {
      await expect(
        Promise.race([
          interrupted.promise.then(() => "preempted"),
          settled.then(() => "manual settled before cleanup"),
        ]),
      ).resolves.toBe("preempted");
      expect(events).toEqual([]);
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      releaseCleanup.resolve();
      await expect(pending).resolves.toEqual({
        ok: false,
        compacted: false,
        compactionKind: "context-engine",
        reason: "session writer claim changed before transcript persistence",
        result: undefined,
      });
      await settled;
      expect(events).toEqual(["maintenance cleanup finished", "manual resolved"]);
      expectNoCalls(contextEngineCompactMock, maybeCompactAgentHarnessSessionMock, runCliAgentMock);
      expect(loadSessionEntryReadOnly(successorTarget)).toEqual(acceptedEntry);
      expect(await loadTranscriptEvents(successorTarget)).toEqual(transcriptBefore);
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([maintenance, pending, settled]);
    }
  });

  it("cancels only the target during runtime admission", async () => {
    const sourceController = new AbortController();
    const admissionStarted = createDeferred<AbortSignal | undefined>();
    acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce((async (
      _input: Record<string, unknown>,
      options?: { abortSignal?: AbortSignal },
    ): Promise<never> => {
      const signal = options?.abortSignal;
      admissionStarted.resolve(signal);
      if (!signal) {
        throw new Error("prepared runtime lease admission did not receive the caller signal");
      }
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("Prepared model runtime lease admission aborted", {
              cause: signal.reason,
            });
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }) as never);

    const pending = compactQueued({ abortSignal: sourceController.signal, trigger: "manual" });
    const admittedSignal = expectDefined(
      await admissionStarted.promise,
      "prepared runtime lease admission signal",
    );
    expect(abortEmbeddedAgentRun(TEST_SESSION_ID)).toBe(true);

    await expect(pending).resolves.toMatchObject(abortedCompaction);
    expect(sourceController.signal.aborted).toBe(false);
    expect(admittedSignal.aborted).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
  });

  it("releases the prepared runtime lease when host authority expires after admission", async () => {
    const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");
    const parent = new AsyncWorkScope();
    const admissionStarted = createDeferred();
    const releaseAdmission = createDeferred();
    const releaseLease = vi.fn(async () => {});
    const defaultAcquire = expectDefined(
      acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
      "default prepared runtime acquisition mock",
    );
    let hostActive = true;
    acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce((async (
      input: Parameters<typeof acquireAgentRunPreparedModelRuntimeMock>[0],
    ) => {
      admissionStarted.resolve(undefined);
      await releaseAdmission.promise;
      const lease = await defaultAcquire(input);
      return { ...lease, [Symbol.asyncDispose]: releaseLease };
    }) as never);

    const pending = parent.run(() =>
      compactEmbeddedAgentSession(wrappedCompactionArgs(), {
        assertActive: () => {
          if (!hostActive) {
            throw new Error("queued compaction host authority expired");
          }
        },
      }),
    );
    await admissionStarted.promise;
    hostActive = false;
    releaseAdmission.resolve(undefined);

    try {
      await expect(pending).rejects.toThrow("queued compaction host authority expired");
    } finally {
      await AsyncWorkScope.runWhenAllIdle(
        () => [parent],
        () => parent.drain(),
      );
    }
    expect(releaseLease).toHaveBeenCalledTimes(1);
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
  });

  it("stops preparation when host authority expires during context-engine resolution", async () => {
    const resolutionStarted = createDeferred();
    const releaseResolution = createDeferred();
    let hostActive = true;
    resolveContextEngineMock.mockImplementationOnce(async () => {
      resolutionStarted.resolve(undefined);
      await releaseResolution.promise;
      return {
        info: { ownsCompaction: true },
        compact: contextEngineCompactMock,
      };
    });

    const pending = compactEmbeddedAgentSession(wrappedCompactionArgs(), {
      assertActive: () => {
        if (!hostActive) {
          throw new Error("queued compaction host authority expired");
        }
      },
    });
    await resolutionStarted.promise;
    hostActive = false;
    releaseResolution.resolve(undefined);

    await expect(pending).rejects.toThrow("queued compaction host authority expired");
    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(selectAgentHarnessForPreparedModelProvidersMock).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
  });

  it("reports budget compaction cancellation during context-engine resolution", async () => {
    const sourceController = new AbortController();
    const resolutionStarted = createDeferred();
    const releaseResolution = createDeferred();
    resolveContextEngineMock.mockImplementationOnce(async () => {
      resolutionStarted.resolve(undefined);
      await releaseResolution.promise;
      return {
        info: { ownsCompaction: true },
        compact: contextEngineCompactMock,
      };
    });

    const pending = compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        abortSignal: sourceController.signal,
        trigger: "budget",
      }),
    );
    await resolutionStarted.promise;
    sourceController.abort(new Error("request timed out"));
    releaseResolution.resolve(undefined);

    await expect(pending).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: "compaction aborted",
    });
    expect(resolveModelAsyncMock).not.toHaveBeenCalled();
    expect(selectAgentHarnessForPreparedModelProvidersMock).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(enqueueCommandInLaneMock).not.toHaveBeenCalled();
  });

  it("resolves the durable session key before invoking an owning context engine", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "openclaw-compaction-session-key-")));
    const storePath = join(dir, "sessions.json");
    const sessionId = "9d6c8436-7cb2-4bd5-a302-e33305bfc8c4";
    const sessionKey = "agent:main:telegram:direct:reporter";
    try {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      hookRunner.hasHooks.mockReturnValue(true);

      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          agentId: "main",
          config: { session: { store: storePath } },
          sessionFile: "",
          sessionId,
          sessionKey: undefined,
          sessionTarget: undefined,
        }),
      );

      expect(result.ok).toBe(true);
      expectRecordFields(mockCallArg(contextEngineCompactMock), {
        sessionId,
        sessionKey,
      });
      expectRecordFields(
        (mockCallArg(contextEngineCompactMock) as { sessionTarget?: unknown }).sessionTarget,
        { agentId: "main", sessionId, sessionKey, storePath },
      );
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), { sessionKey });
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), { sessionKey });
    } finally {
      await compactionFixture.cleanupDirectory(dir);
    }
  });

  it("does not require an implicit default owner for queued compaction", async () => {
    await upsertSessionEntryCore(
      {
        agentId: "marie-clawndo",
        sessionKey: "agent:marie-clawndo:dashboard:session-1",
        storePath: TEST_STORE_PATH,
      },
      { sessionId: TEST_SESSION_ID, updatedAt: 1 },
    );
    resolveDefaultAgentDirMock.mockImplementation(() => {
      throw new Error("ambiguous default agent");
    });
    resolveSessionAgentIdsMock.mockReturnValue({
      defaultAgentId: "marie-clawndo",
      sessionAgentId: "marie-clawndo",
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        agentId: "marie-clawndo",
        config: {
          agents: {
            ownership: "explicit",
            list: [{ id: "main" }, { id: "marie-clawndo" }],
          },
        },
        sessionKey: "agent:marie-clawndo:dashboard:session-1",
        sessionTarget: {
          agentId: "marie-clawndo",
          sessionId: TEST_SESSION_ID,
          sessionKey: "agent:marie-clawndo:dashboard:session-1",
          storePath: TEST_STORE_PATH,
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(acquireAgentRunPreparedModelRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "marie-clawndo" }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
  });

  it("disposes the context engine once when route materialization rejects", async () => {
    const dispose = vi.fn(async () => {});
    const { authStorage } = createCompactHooksResolvedModel();
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
      dispose,
    } as never);
    resolveModelAsyncMock
      .mockImplementationOnce(async (provider, modelId) => ({
        logicalRef: { provider, model: modelId },
        model: {
          provider: "openai",
          id: "fake",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          input: [],
        },
        error: null,
        authStorage,
        modelRegistry: {},
      }))
      .mockRejectedValueOnce(new Error("route materialization failed"));

    await expect(
      compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "fake",
          runtimeAuthPlan: {
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "fake",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        }),
      ),
    ).rejects.toThrow("route materialization failed");
    const snapshot = await acquiredPreparedModelRuntime();
    expect(
      (mockCallArg(resolveModelAsyncMock, 1, 4) as { preparedModelRuntime?: unknown })
        .preparedModelRuntime,
    ).toBe(snapshot);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(enqueueCommandInLaneMock).not.toHaveBeenCalled();
  });

  it("stops preparation when host authority expires during model resolution before route rematerialization", async () => {
    const modelResolutionStarted = createDeferred();
    const releaseModelResolution = createDeferred();
    let hostActive = true;
    resolveModelAsyncMock.mockImplementationOnce(async (provider, modelId) => {
      modelResolutionStarted.resolve(undefined);
      await releaseModelResolution.promise;
      return {
        ...createCompactHooksResolvedModel(provider, modelId),
        model: {
          provider: "openai",
          id: "fake",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          input: [],
        },
      };
    });

    const pending = compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "fake",
        runtimeAuthPlan: {
          providerForAuth: "openai",
          authProfileProviderForAuth: "openai",
          selectedAuthMode: "api-key",
          modelRoute: openaiRoute(undefined, "fake"),
        },
      }),
      {
        assertActive: () => {
          if (!hostActive) {
            throw new Error("queued compaction host authority expired");
          }
        },
      },
    );
    await modelResolutionStarted.promise;
    hostActive = false;
    releaseModelResolution.resolve(undefined);

    await expect(pending).rejects.toThrow("queued compaction host authority expired");
    expect(resolveModelAsyncMock).toHaveBeenCalledTimes(1);
    expectNoCalls(
      selectAgentHarnessForPreparedModelProvidersMock,
      contextEngineCompactMock,
      maybeCompactAgentHarnessSessionMock,
      enqueueCommandInLaneMock,
    );
  });

  it("preserves native failures when engine disposal also throws", async () => {
    const dispose = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    mockContextEngine(false, false, { dispose });
    maybeCompactAgentHarnessSessionMock.mockRejectedValueOnce(
      new Error("native compaction failed"),
    );

    await expect(compactQueued(codexArgs())).rejects.toThrow("native compaction failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(enqueueCommandInLaneMock).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "waits for the active session lane", writerRunId: undefined },
    { outcome: "rejects a replaced writer claim", writerRunId: "replacement-run" },
  ])("shipped /compact $outcome before native compaction", async ({ writerRunId }) => {
    const command = await import("../../auto-reply/reply/commands-compact.test-support.js");
    vi.mocked(command.compactEmbeddedAgentSession).mockReset();
    const compactionParams = await nativeCompactionArgs({ agentHarnessId: "codex" });
    mockContextEngine(false);
    mockNativeCompactionSuccess();
    const { entered: laneEntered, release: laneRelease } = blockQueuedLane();
    vi.mocked(command.compactEmbeddedAgentSession).mockImplementationOnce(
      async (params, host) => await compactEmbeddedAgentSession(params, host),
    );

    const pending = command.handleCompactCommand(
      {
        ...command.buildCompactParams("/compact", {
          commands: { text: true },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: TEST_STORE_PATH },
        }),
        sessionKey: compactionParams.sessionKey,
        storePath: compactionParams.sessionTarget.storePath,
        provider: "openai",
        model: "gpt-5.5",
        workspaceDir: TEST_WORKSPACE_DIR,
        agentDir: join(TEST_WORKSPACE_DIR, "agents/main/agent"),
        sessionEntry: expectDefined(
          loadSessionEntryReadOnly(compactionParams.sessionTarget),
          "seeded native compaction session",
        ),
      },
      true,
    );
    await laneEntered.promise;
    expect(enqueueCommandInLaneMock).toHaveBeenCalledOnce();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();

    if (writerRunId) {
      await patchSessionEntryCore(wrappedCompactionArgs().sessionTarget, (entry) => ({
        ...entry,
        activeWriterRunId: writerRunId,
      }));
    }
    laneRelease.resolve();
    if (writerRunId) {
      await expect(pending).rejects.toThrow("session writer claim changed");
    } else {
      await expect(pending).resolves.toMatchObject({ shouldContinue: false });
    }
    expect(command.compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(writerRunId ? 0 : 1);
  });

  it("delegates summaryless server-endpoint results", async () => {
    mockContextEngine(false);
    contextEngineCompactMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        firstKeptEntryId: "assistant-entry",
        tokensBefore: 1_000,
        tokensAfter: 200,
        details: { compactionKind: "server-endpoint" },
      },
    });

    const result = await compactQueued({ provider: "xai", model: "grok-4.5" });

    expect(result).toMatchObject({
      compactionKind: "server-endpoint",
      result: { kind: "server-endpoint", tokensAfter: 200 },
    });
    expect(result.result).not.toHaveProperty("summary");
  });

  it("allows cross-route direct fallback through queued compaction", async () => {
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1 as const,
      profiles: {
        "openai:subscription": {
          type: "token" as const,
          provider: "openai",
          token: "subscription-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:subscription"] },
    });
    getApiKeyForModelMock.mockImplementation(async (authParams = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.allowAuthProfileFallback === false) {
        return { apiKey: "literal-key", mode: "api-key", source: "models.json" };
      }
      throw new Error("unexpected auth lookup");
    });
    mockDelegatingEngine();

    const result = await compactQueued({
      provider: "openai",
      model: "gpt-5.5",
      config: providerConfig("openai", {
        apiKey: "literal-key",
        models: [{ id: "gpt-5.5" }],
      }),
    });

    expect(result.ok).toBe(true);
    expect(
      getApiKeyForModelMock.mock.calls.map(([authParams]) => ({
        profileId: authParams?.profileId,
        allowAuthProfileFallback: authParams?.allowAuthProfileFallback,
      })),
    ).toEqual([
      { profileId: "openai:subscription", allowAuthProfileFallback: undefined },
      { profileId: undefined, allowAuthProfileFallback: false },
    ]);
  });

  it("cancels in-flight native CLI compaction", async () => {
    const controller = new AbortController();
    const cancellation = new Error("request timed out");
    const cliStarted = createDeferred<AbortSignal>();
    runCliAgentMock.mockImplementationOnce((async (params: { abortSignal?: AbortSignal }) => {
      const signal = expectDefined(params.abortSignal, "native CLI compaction abort signal");
      cliStarted.resolve(signal);
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(cancellation), { once: true });
      });
    }) as never);
    const pending = compactEmbeddedAgentSession(nativeCliArgs({ abortSignal: controller.signal }));
    const nativeSignal = await cliStarted.promise;
    controller.abort(cancellation);
    await expect(pending).resolves.toEqual(abortedCompaction);
    expect(nativeSignal.aborted).toBe(true);
    expect(nativeSignal.reason).toBe(cancellation);
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
  });

  it("checks writer authority before native CLI compaction", async () => {
    const { entered: laneEntered, release: laneRelease } = blockQueuedLane();
    const params = nativeCliArgs();
    const pending = compactEmbeddedAgentSession(params);
    await laneEntered.promise;
    expect(enqueueCommandInLaneMock).toHaveBeenCalledOnce();
    await patchSessionEntryCore(params.sessionTarget, (entry) => ({
      ...entry,
      activeWriterRunId: "replacement-run",
    }));
    laneRelease.resolve();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("session writer claim changed"),
    });
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it.each(["subscription", "custom endpoint"] as const)(
    "materializes the %s route before queued compaction",
    async (route) => {
      const subscription = route === "subscription";
      const api = subscription ? "openai-chatgpt-responses" : "openai-responses";
      const baseUrl = subscription
        ? "https://chatgpt.com/backend-api/codex"
        : "https://example.test/v1";
      const modelRoute = openaiRoute(baseUrl);
      const harnessPolicy = subscription
        ? { runtime: "codex", runtimeSource: "model" }
        : { runtime: "codex" };
      resolveAgentHarnessPolicyMock.mockReturnValue(harnessPolicy);
      if (subscription) {
        resolveContextWindowInfoMock.mockImplementation(
          (input?: { modelContextWindow?: number }) => ({
            tokens: input?.modelContextWindow ?? 128_000,
          }),
        );
        ensureAuthProfileStoreMock.mockReturnValue({
          version: 1,
          profiles: {
            "openai:token": { type: "token", provider: "openai", token: "subscription-token" },
          },
          order: { openai: ["openai:token"] },
        });
      }
      mockNativeCompactionSuccess();
      const result = await compactQueued(
        codexArgs(
          subscription
            ? { authProfileId: "openai:token", authProfileIdSource: "auto" }
            : {
                runtimeAuthPlan: authPlan({ modelRoute }),
                config: providerConfig("openai", {
                  api,
                  baseUrl,
                  models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
                }),
              },
        ),
      );
      expect(result.ok).toBe(true);
      if (subscription) {
        expect(mockCallArg(resolveModelAsyncMock, 0, 4)).toEqual(
          expect.objectContaining({ authProfileId: "openai:token" }),
        );
        expect(resolveModelAsyncMock).toHaveBeenLastCalledWith(
          "openai",
          "gpt-5.5",
          expect.any(String),
          expect.objectContaining(
            providerConfig("openai", expect.objectContaining({ api, baseUrl })),
          ),
          expect.objectContaining({ authProfileMode: "token" }),
        );
        expectCall(contextEngineCompactMock, { tokenBudget: 272_000 });
      } else {
        expect(mockCallArg(resolveModelMock)).toBe("openai");
        expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
          provider: "openai",
          modelId: "gpt-5.5",
        });
      }
      expectCall(
        maybeCompactAgentHarnessSessionMock,
        {
          ...(subscription
            ? {
                authProfileId: "openai:token",
                authProfileIdSource: "auto",
                contextTokenBudget: 272_000,
              }
            : { provider: "openai", model: "gpt-5.5", agentHarnessId: "codex" }),
          runtimeModel: expect.objectContaining({
            api,
            baseUrl,
            ...(subscription ? { contextWindow: 272_000 } : {}),
          }),
          runtimeAuthPlan: subscription ? undefined : expect.objectContaining({ modelRoute }),
        },
        expectedNativeCompactionOptions("after_context_engine"),
      );
      expect(contextEngineCompactMock.mock.invocationCallOrder[0]).toBeLessThan(
        maybeCompactAgentHarnessSessionMock.mock.invocationCallOrder[0]!,
      );
      const compactArg = mockCallArg(contextEngineCompactMock) as {
        runtimeContext?: Record<string, unknown>;
      };
      expectRecordFields(compactArg.runtimeContext, {
        provider: "openai",
        runtimeProvider: undefined,
        model: "gpt-5.5",
      });
    },
  );

  it("reports deferred compaction scheduling failures", async () => {
    const dispose = vi.fn(async () => {});
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true, turnMaintenanceMode: "background" },
      compact: contextEngineCompactMock,
      dispose,
      maintain,
    } as never);
    enqueueCommandInLaneMock.mockImplementationOnce(() => {
      throw new Error("scheduler offline");
    });

    const result = await compactQueued({
      trigger: "budget",
      deferOwningContextEngineCompaction: true,
    });

    expect(result).toMatchObject({
      ok: false,
      compacted: false,
      reason: "failed to schedule background context-engine maintenance",
      failure: { reason: "deferred_compaction_not_scheduled" },
    });
    expect(dispose).toHaveBeenCalledTimes(1);
    expectNoCalls(maintain, contextEngineCompactMock);
  });

  it.each([
    [
      "codex",
      "stale_thread_binding",
      "codex app-server binding changed before native compaction",
      true,
    ],
    ["copilot", "missing_thread_binding", "no copilot app-server thread binding", false],
  ] as const)(
    "permits locked %s preflight fallback only after native capability use",
    async (agentHarnessId, failureReason, reason, nativeCapabilityUsed) => {
      if (nativeCapabilityUsed) {
        mockContextEngine(false);
      }
      maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async (...args: unknown[]) => {
        if (nativeCapabilityUsed) {
          const options = args[1] as { onNativeCompactionCapabilityUsed?: () => void } | undefined;
          options?.onNativeCompactionCapabilityUsed?.();
        }
        return {
          ok: false,
          compacted: false,
          reason,
          failure: {
            reason: failureReason,
            ...(!nativeCapabilityUsed ? { fallback: "context-engine" } : {}),
          },
        };
      });
      const result = await compactNative({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId,
        trigger: "budget",
        preflightRequired: true,
        ...(nativeCapabilityUsed
          ? {
              config: providerConfig("openai", {
                models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
              }),
            }
          : {}),
      });
      expect(result).toMatchObject(
        nativeCapabilityUsed
          ? {
              ok: true,
              compacted: true,
              result: { summary: "engine-summary" },
            }
          : {
              ok: false,
              compacted: false,
              failure: { reason: failureReason },
            },
      );
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(1);
      expectCall(
        maybeCompactAgentHarnessSessionMock,
        {
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId,
          preflightRequired: true,
        },
        expect.objectContaining({ nativeCompactionRequest: "required_preflight" }),
      );
      expect(contextEngineCompactMock).toHaveBeenCalledTimes(nativeCapabilityUsed ? 1 : 0);
    },
  );

  it.each([
    { agentHarnessId: "auto", model: "gpt-5.6-luna", nativeCalls: 0 },
    { agentHarnessId: "codex", model: "gpt-5.5", nativeCalls: 1 },
  ])(
    "fails a native lock when $agentHarnessId has no compaction result",
    async ({ agentHarnessId, model, nativeCalls }) => {
      if (nativeCalls) {
        maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce(undefined);
      }
      const result = await compactNative({
        provider: "openai",
        model,
        agentHarnessId,
        currentTokenCount: 333,
      });
      expect(result).toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: "model_selection_locked" },
      });
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(nativeCalls);
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
    },
  );

  it("runs native manual compaction before generic auth", async () => {
    const result = await compactNative({ ...nativeCliArgs(), agentHarnessId: "claude-cli" });
    expect(result).toMatchObject({ ok: true, compacted: true });
    expectCall(runCliAgentMock, { cliSessionId: "native-session", controlOperation: "compact" });
    expectNoCalls(acquireAgentRunPreparedModelRuntimeMock, contextEngineCompactMock);
  });

  it("holds the lane until secondary native compaction terminates", async () => {
    useCodexPolicy();
    const nativeStarted = createDeferred();
    const nativeResult = {
      ok: true as const,
      compacted: true as const,
      result: { summary: "", firstKeptEntryId: "", tokensBefore: 333 },
    };
    const nativeTerminal = createDeferred<typeof nativeResult>();
    maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async () => {
      nativeStarted.resolve();
      return await nativeTerminal.promise;
    });
    vi.useFakeTimers();
    let settled = false;
    const resultPromise = compactQueued({
      provider: "codex",
      model: "gpt-5.4",
      agentHarnessId: "codex",
      trigger: "budget",
    }).finally(() => {
      settled = true;
    });
    void resultPromise.catch(() => undefined);
    try {
      await Promise.race([nativeStarted.promise, resultPromise]);
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      // The native terminal owner, not another host aggregate window, holds this lane.
      await vi.advanceTimersByTimeAsync(30_001);
      expect(settled).toBe(false);

      nativeTerminal.resolve(nativeResult);
      await expect(resultPromise).resolves.toMatchObject({ ok: true, compacted: true });
    } finally {
      nativeTerminal.resolve(nativeResult);
      await resultPromise.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("sweeps past faulty probes to cancel live compaction", async () => {
    const faultyAbort = vi.fn();
    const faultyHandle = {
      kind: "embedded" as const,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => {
        throw new Error("compaction probe unavailable");
      },
      abort: faultyAbort,
    };
    setActiveEmbeddedRun("session-faulty-probe", faultyHandle, "agent:main:faulty-probe");
    const pending = mockPendingContextEngineCompaction();
    try {
      const resultPromise = compactQueued({ trigger: "manual" });
      await pending.started.promise;
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);

      // An unreadable compaction state fails closed: the caller keeps the same
      // structured rejection a run that cannot take steering returns, and the probe
      // exception never reaches the steering caller.
      await expect(steerTestSessionTurn("session-faulty-probe", "steer")).resolves.toMatchObject({
        status: "rejected",
        reason: "injection_unavailable",
      });
      await expect(steerTestSessionTurn(TEST_SESSION_ID, "steer")).resolves.toMatchObject({
        status: "rejected",
        reason: "injection_unavailable",
      });

      expect(abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })).toBe(
        true,
      );
      expect(faultyAbort).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive("session-faulty-probe")).toBe(true);
      expect(pending.signal?.aborted).toBe(true);

      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: expect.stringContaining("abort"),
      });
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
      const settled = waitForSessionRunEnd(TEST_SESSION_ID, null);
      pending.release.resolve(undefined);
      await expect(settled).resolves.toBe(true);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    } finally {
      pending.release.resolve(undefined);
      clearActiveEmbeddedRun("session-faulty-probe", faultyHandle, "agent:main:faulty-probe");
    }
  });

  it.each([
    { position: "primary", ownsCompaction: false, abortReason: "user_abort", resultOk: false },
    { position: "secondary", ownsCompaction: true, abortReason: "restart", resultOk: true },
  ] as const)(
    "aborts $position native harness compaction through the registered handle",
    async ({ ownsCompaction, abortReason, resultOk }) => {
      mockContextEngine(ownsCompaction);
      useCodexPolicy();
      const pending = mockPendingNativeCompaction();
      const resultPromise = compactQueued(codexArgs({ model: "gpt-5.4", trigger: "manual" }));

      try {
        await pending.started.promise;
        const operation = getSessionControllerOperation(TEST_SESSION_KEY);
        const aborted =
          abortReason === "restart"
            ? abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })
            : abortEmbeddedAgentRun(TEST_SESSION_ID);
        expect(aborted).toBe(true);
        expect(pending.signal?.reason).toBe(operation?.abortSignal.reason);
        expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
        pending.terminal.resolve({ ok: false, compacted: false, reason: "aborted" });

        await expect(resultPromise).resolves.toMatchObject({ ok: resultOk });
        expect(contextEngineCompactMock).toHaveBeenCalledTimes(ownsCompaction ? 1 : 0);
        expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
      } finally {
        pending.terminal.resolve({ ok: false, compacted: false, reason: "aborted" });
        await resultPromise.catch(() => undefined);
      }
    },
  );

  it("borrows the exact active reply operation for manual preflight compaction", async () => {
    const { withSessionTurn } = await import("../../sessions/session-controller.admission.js");
    await withSessionTurn(wrappedCompactionArgs(), async (admitted) => {
      const replyOperation = expectDefined(admitted, "admitted preflight turn");
      replyOperation.setPhase("preflight_compacting");
      expect(isSessionRunActive(TEST_SESSION_ID)).toBe(true);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
      const pending = mockPendingContextEngineCompaction();
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({ abortSignal: replyOperation.abortSignal, trigger: "manual" }),
      );
      try {
        await pending.started.promise;
        expect(isSessionRunActive(TEST_SESSION_ID)).toBe(true);
        expect(getSessionControllerOperation(TEST_SESSION_KEY)).toBe(replyOperation);
        expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
        expect(replyOperation.abortByUser()).toBe(true);
        expect(pending.signal?.aborted).toBe(true);
        expect(pending.signal?.reason).toBe(replyOperation.abortSignal.reason);
        pending.release.resolve(undefined);
        await expect(resultPromise).resolves.toMatchObject({ ok: false, compacted: false });
        expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
        expect(isSessionRunActive(TEST_SESSION_ID)).toBe(true);
      } finally {
        pending.release.resolve(undefined);
        await resultPromise.catch(() => undefined);
      }
    });
  });

  it.each([
    { identity: "session key", activeSessionKey: TEST_SESSION_KEY, foreignStore: false },
    {
      identity: "incarnation alias",
      activeSessionKey: "agent:main:other-session",
      foreignStore: false,
    },
    { identity: "foreign store", activeSessionKey: TEST_SESSION_KEY, foreignStore: true },
  ])("scopes manual compaction against an active $identity", async (active) => {
    const { withSessionTurn } = await import("../../sessions/session-controller.admission.js");
    const activeSessionId =
      active.identity === "incarnation alias" ? TEST_SESSION_ID : "other-session";
    const existingHandle = {
      kind: "embedded" as const,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    const entered = createDeferred();
    const release = createDeferred();
    const activeTarget = {
      agentId: "main",
      sessionId: activeSessionId,
      sessionKey: active.activeSessionKey,
      storePath: active.foreignStore ? join(TEST_WORKSPACE_DIR, "foreign.sqlite") : TEST_STORE_PATH,
    };
    const owner = withSessionTurn(activeTarget, async (operation) => {
      setActiveEmbeddedRun(
        activeSessionId,
        existingHandle,
        active.activeSessionKey,
        TEST_SESSION_KEY,
        "main",
        operation,
      );
      entered.resolve();
      try {
        await release.promise;
      } finally {
        clearActiveEmbeddedRun(activeSessionId, existingHandle);
      }
    });
    await entered.promise;
    try {
      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({ trigger: "manual" }),
      );
      expect(result).toMatchObject(
        active.foreignStore
          ? { ok: true, compacted: true }
          : { ok: false, compacted: false, failure: { reason: "active_run" } },
      );
      expect(contextEngineCompactMock).toHaveBeenCalledTimes(active.foreignStore ? 1 : 0);
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      expect(existingHandle.abort).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive(activeSessionId)).toBe(true);
    } finally {
      release.resolve();
      await owner;
    }
  });

  it.each(["session-key", "SQLite marker"] as const)(
    "rejects a %s successor that contradicts its stored identity",
    async (format) => {
      const dir =
        format === "session-key"
          ? await realpath(await mkdtemp(join(tmpdir(), "openclaw-compaction-successor-mismatch-")))
          : undefined;
      const storePath = dir ? join(dir, "sessions.json") : TEST_STORE_PATH;
      const activeTarget = { ...wrappedCompactionArgs().sessionTarget, storePath };
      const delegatedSessionKey = "agent:main:delegated-key-mismatch";
      mockContextEngine(false);
      contextEngineCompactMock.mockResolvedValue({
        ok: true,
        compacted: true,
        result:
          format === "session-key"
            ? {
                sessionFile: delegatedSessionKey,
                sessionId: "reported-session",
              }
            : {
                sessionFile: `sqlite:main:marker-session:${storePath}`,
                sessionId: TEST_SESSION_ID,
              },
      } as never);
      try {
        if (format === "session-key") {
          await upsertSessionEntryCore(activeTarget, { sessionId: TEST_SESSION_ID, updatedAt: 1 });
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: delegatedSessionKey, storePath },
            { sessionId: "stored-session", updatedAt: 1 },
          );
        }
        await expect(compactQueued({ sessionTarget: activeTarget })).rejects.toThrow(
          "successor identity is inconsistent",
        );
        expect(contextEngineCompactMock).toHaveBeenCalledOnce();
      } finally {
        if (dir) {
          await compactionFixture.cleanupDirectory(dir);
        }
      }
    },
  );

  it("catches and logs hook exceptions without aborting compaction", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeCompaction.mockRejectedValue(new Error("hook boom"));

    const result = await compactQueued();

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
  });
  it("prepares native harness auth without a host profile", async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    useCodexPolicy();
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    mockNativeCompactionSuccess();

    await compactQueued(codexArgs());

    expectCall(selectAgentHarnessForPreparedModelProvidersMock, {
      modelProviders: expect.arrayContaining([
        expect.objectContaining({
          preparedAuth: expect.objectContaining({ source: "harness" }),
          runtimePolicy: expect.objectContaining({ compatibleIds: ["openclaw", "codex"] }),
        }),
      ]),
    });
    expectCall(
      maybeCompactAgentHarnessSessionMock,
      { runtimeAuthPlan: undefined },
      expectedNativeCompactionOptions("after_context_engine"),
    );
  });

  it.each(["SQLite marker", "partial structured target"] as const)(
    "keeps a %s successor in the active store for legacy maintenance",
    async (format) => {
      const maintain = vi.fn(async (_params?: unknown) => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }));
      const delegatedSessionId =
        format === "SQLite marker" ? "delegated-marker-session" : "delegated-session";
      const storePath =
        format === "SQLite marker"
          ? TEST_STORE_PATH
          : join(TEST_WORKSPACE_DIR, "custom-active-sessions.json");
      const sessionTarget = { ...wrappedCompactionArgs().sessionTarget, storePath };
      if (format === "partial structured target") {
        await upsertSessionEntryCore(sessionTarget, { sessionId: TEST_SESSION_ID, updatedAt: 1 });
      }
      const marker = `sqlite:main:${delegatedSessionId}:${storePath}`;
      mockContextEngine(false, false, { maintain });
      contextEngineCompactMock.mockResolvedValue({
        ok: true,
        compacted: true,
        result:
          format === "SQLite marker"
            ? { sessionFile: marker, sessionId: delegatedSessionId }
            : { sessionTarget: { sessionId: delegatedSessionId } },
      } as never);
      const result = await compactQueued({ sessionTarget });
      expect(result.ok).toBe(true);
      expectRecordFields(mockCallArg(maintain), {
        sessionId: delegatedSessionId,
        ...(format === "SQLite marker" ? { sessionFile: marker } : {}),
        sessionTarget: expect.objectContaining({
          agentId: "main",
          sessionId: delegatedSessionId,
          sessionKey: TEST_SESSION_KEY,
          storePath,
        }),
      });
    },
  );
  it("resolves the durable session key before engine invocation", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "openclaw-compaction-session-key-")));
    const storePath = join(dir, "sessions.json");
    const sessionId = "9d6c8436-7cb2-4bd5-a302-e33305bfc8c4";
    const sessionKey = "agent:main:telegram:direct:reporter";
    try {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey, storePath },
        { sessionId, updatedAt: 1 },
      );
      hookRunner.hasHooks.mockReturnValue(true);

      const result = await compactQueued({
        agentId: "main",
        config: { session: { store: storePath } },
        sessionFile: "",
        sessionId,
        sessionKey: undefined,
        sessionTarget: undefined,
      });

      expect(result.ok).toBe(true);
      expect(mockCallArg(contextEngineCompactMock)).toMatchObject({
        sessionId,
        sessionKey,
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
      });
      expectRecordFields(mockCallArg(hookRunner.runBeforeCompaction, 0, 1), { sessionKey });
      expectRecordFields(mockCallArg(hookRunner.runAfterCompaction, 0, 1), { sessionKey });
    } finally {
      await compactionFixture.cleanupDirectory(dir);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
