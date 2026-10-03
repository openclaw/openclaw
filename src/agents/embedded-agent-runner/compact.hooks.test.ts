// Hook integration coverage for direct and queued embedded compaction.

import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { getModelProviderRuntimePluginHandle } from "../../plugins/provider-hook-runtime.js";
import {
  requireActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import type { CommandQueueEnqueueOptions } from "../../process/command-queue.types.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { getModelProviderLocalServiceReconciler } from "../provider-local-service-reconcile.js";
import { createSessionMaintenanceOwner } from "../session-maintenance/coordinator.js";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../sessions/agent-session-loop-resource-loader.test-support.js";
import { generateSummary as generateRealSummary } from "../sessions/compaction/compaction.js";
import { createEventBus } from "../sessions/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../sessions/extensions/loader.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import {
  expectRecordFields,
  findMockCall,
  mockCallArg,
} from "./compact.hooks.assertions.test-support.js";
import {
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
  resolveEffectiveCompactionModeMock,
  resolveEmbeddedAgentStreamMock,
  resolveModelAsyncMock,
  resolveModelMock,
  resolveSandboxContextMock,
  resolveSkillsPromptMock,
  resolveSessionAgentIdMock,
  runCliAgentMock,
  selectAgentHarnessForPreparedModelProvidersMock,
  selectAgentHarnessMock,
  resetCompactSessionStateMocks,
  sessionAutomaticCompactionMock,
  sessionMessages,
  sessionCompactImpl,
  sessionManualCompactionMock,
  triggerInternalHookMock,
} from "./compact.hooks.harness.js";
import {
  registerDirectProviderRefreshTests,
  registerQueuedProviderRefreshTest,
} from "./compact.hooks.memory-refresh.test-support.js";
import {
  getMemorySearchManagerMock,
  resolveMemorySearchConfigMock,
} from "./compact.hooks.memory.test-support.js";
import {
  createCompactHooksAuthStorage,
  createCompactHooksPreparedModelRuntime,
  type CompactHooksQueuedCompaction,
} from "./compact.hooks.metadata.test-support.js";
import {
  mockPendingContextEngineCompaction,
  mockPendingNativeCompaction,
} from "./compact.hooks.pending.test-support.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "./runs.js";

let compactEmbeddedAgentSessionDirect: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let compactEmbeddedAgentSession: CompactHooksQueuedCompaction;
let compactTesting: typeof import("./compact.hooks.owner-test-support.js");
let onSessionTranscriptUpdate: typeof import("../../sessions/transcript-events.js").onSessionTranscriptUpdate;

let TEST_STORE_PATH: string;
let TEST_SESSION_ID: string;
const TEST_SESSION_KEY = "agent:main:session-1";
const compactionFixture = useCompactHooksSessionFixture(TEST_SESSION_KEY);
let TEST_SESSION_FILE: string;
let TEST_WORKSPACE_DIR: string;
const TEST_CUSTOM_INSTRUCTIONS = "focus on decisions";
type SessionHookEvent = {
  type?: string;
  action?: string;
  sessionKey?: string;
  context?: Record<string, unknown>;
};
type PostCompactionSyncParams = {
  archiveFiles?: string[];
  reason: string;
  sessionFiles?: string[];
  sessions?: Array<{ agentId: string; sessionId: string; sessionKey?: string }>;
};
type PostCompactionSync = (params?: unknown) => Promise<void>;
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

function mockResolvedModel(params?: {
  supportsTools?: boolean;
  input?: string[];
  contextWindow?: number;
  requestTimeoutMs?: number;
}) {
  resolveModelMock.mockReset();
  resolveModelMock.mockImplementation(
    (provider = "openai", modelId = "fake", _agentDir?: string, cfg?: unknown) => {
      const providerConfig = (
        cfg as
          | {
              models?: {
                providers?: Record<string, { api?: string; baseUrl?: string }>;
              };
            }
          | undefined
      )?.models?.providers?.[provider];
      return {
        logicalRef: { provider, model: modelId },
        model: {
          provider,
          api: providerConfig?.api ?? "openai-responses",
          baseUrl: providerConfig?.baseUrl?.trim() || "https://api.openai.com/v1",
          id: modelId,
          input: params?.input ?? [],
          ...(params?.contextWindow === undefined ? {} : { contextWindow: params.contextWindow }),
          ...(params?.requestTimeoutMs === undefined
            ? {}
            : { requestTimeoutMs: params.requestTimeoutMs }),
          ...(params?.supportsTools === undefined
            ? {}
            : { compat: { supportsTools: params.supportsTools } }),
        },
        error: null,
        authStorage: createCompactHooksAuthStorage(),
        modelRegistry: {},
      };
    },
  );
}

function compactionConfig(mode: "await" | "off" | "async") {
  return {
    agents: {
      defaults: {
        compaction: {
          postIndexSync: mode,
        },
      },
    },
  } as never;
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
    enqueue: async <T>(task: () => Promise<T> | T) => await task(),
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

function createPreparedCodexCompactionPlans(modelId = "gpt-5.5") {
  const modelRoute = {
    provider: "openai",
    modelId,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["codex"] },
  } as const;
  const runtimeAuthPlan = {
    providerForAuth: "openai",
    modelId,
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: "api-key",
    modelRoute,
  } as const;
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

const sessionHook = (action: string): SessionHookEvent | undefined =>
  triggerInternalHookMock.mock.calls.find((call) => {
    const event = call[0] as SessionHookEvent | undefined;
    return event?.type === "session" && event.action === action;
  })?.[0] as SessionHookEvent | undefined;

beforeAll(async () => {
  const loaded = await loadCompactHooksHarness();
  compactTesting = await import("./compact.hooks.owner-test-support.js");
  compactEmbeddedAgentSessionDirect = (params) =>
    loaded.compactEmbeddedAgentSessionDirect({ agentId: "main", ...params });
  compactEmbeddedAgentSession = loaded.compactEmbeddedAgentSession;
  onSessionTranscriptUpdate = loaded.onSessionTranscriptUpdate;
  TEST_STORE_PATH = await compactionFixture.prepare();
});

beforeEach(async () => {
  ({
    workspaceDir: TEST_WORKSPACE_DIR,
    sessionFile: TEST_SESSION_FILE,
    sessionId: TEST_SESSION_ID,
  } = await compactionFixture.prepareSession());
});

describe("compactEmbeddedAgentSessionDirect hooks", () => {
  beforeEach(() => {
    triggerInternalHookMock.mockClear();
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    mockResolvedModel();
    sessionCompactImpl.mockReset();
    sessionCompactImpl.mockResolvedValue({
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      details: { ok: true },
    });
    resetCompactSessionStateMocks();
  });

  it.each(["bootstrap", "compaction"] as const)(
    "does not retry thinking after a recorded terminal %s failure",
    async (phase) => {
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: contextEngineCompactMock,
      });
      const failure = Object.freeze(
        Object.assign(new Error("Reasoning is mandatory for this endpoint"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      );
      recordModelFallbackStop(failure);
      if (phase === "bootstrap") {
        createAgentSessionMock.mockRejectedValueOnce(failure);
      } else {
        sessionCompactImpl.mockRejectedValueOnce(failure);
      }
      const result = await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({
          provider: "openai",
          model: "fixture-primary",
          modelFallbacksOverride: ["openai/fixture-fallback"],
          thinkLevel: "off",
          customInstructions: "preserve the committed state",
        }),
      );
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      expect(createAgentSessionMock).toHaveBeenCalledOnce();
      expect(sessionCompactImpl).toHaveBeenCalledTimes(phase === "bootstrap" ? 0 : 1);
      expect(result).toMatchObject({ ok: false, compacted: false });
    },
  );

  it("restricts compact endpoint tools and omits private skills under a finite policy", async () => {
    resolveSkillsPromptMock.mockResolvedValue("PRIVATE_SKILL_MARKER");
    createOpenClawCodingToolsMock.mockReturnValue(
      ["read", "exec"].map((name) => ({
        name,
        label: name,
        description: name,
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      })),
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
      input.onCompactionCommitted?.(1_000);
      return {
        item: { type: "compaction", encrypted_content: "opaque" },
        usage: { input_tokens: 1_000, output_tokens: 200 },
      };
    });
    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        provider: "xai",
        model: "grok-4.5",
        trigger: "manual",
        toolsAllow: ["read"],
        customInstructions: undefined,
        config: {
          models: {
            providers: {
              xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1", models: [] },
            },
          },
        },
      }),
    );
    expect(result).toMatchObject({ compacted: true, compactionKind: "server-endpoint" });
    expect(result.result).not.toHaveProperty("summary");
    expect(mockCallArg(applyExtraParamsToAgentMock, 0, 11)).toMatchObject({
      nativeWebSearchPolicyContext: { webSearchEnabled: false, runtimeToolAllowlist: [] },
    });
    expect(endpointSystemPrompt).toBeDefined();
    expect(JSON.parse(endpointSystemPrompt ?? "{}")).toEqual({
      promptMode: "minimal",
      skillsPrompt: null,
      toolNames: ["read"],
    });
  });

  it("prepares the routed peer's account window for server-endpoint compaction", async () => {
    const history = await vi.importActual<typeof import("./history.js")>("./history.js");
    getHistoryLimitFromSessionKeyMock.mockImplementationOnce(history.getHistoryLimitFromSessionKey);
    limitHistoryTurnsMock.mockImplementationOnce(history.limitHistoryTurns);
    attemptServerEndpointCompactionMock.mockImplementationOnce(async (input) => {
      input.onCompactionCommitted?.(1_000);
      return {
        item: { type: "compaction", encrypted_content: "opaque" },
        usage: { input_tokens: 1_000, output_tokens: 200 },
      };
    });
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
    await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
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
      }),
    );
    expect(attemptServerEndpointCompactionMock).toHaveBeenCalledOnce();
    expect(attemptServerEndpointCompactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          messages: [
            { role: "user", content: "turn-5", timestamp: 5 },
            { role: "user", content: "turn-6", timestamp: 6 },
          ],
        }),
      }),
    );
  });

  it("refreshes the delegated watchdog before delayed fallback setup", async () => {
    const compactionTimeoutReset = vi.fn();
    const fallbackSetupStarted = createDeferred<number>();
    const fallbackSetupReleased = createDeferred();
    const createAgentSession = createAgentSessionMock.getMockImplementation();
    if (!createAgentSession) {
      throw new Error("Expected a create-agent-session implementation");
    }
    createAgentSessionMock.mockImplementation(async (...args) => {
      if (createAgentSessionMock.mock.calls.length === 2) {
        fallbackSetupStarted.resolve(compactionTimeoutReset.mock.calls.length);
        await fallbackSetupReleased.promise;
      }
      return await createAgentSession(...args);
    });
    sessionCompactImpl
      .mockRejectedValueOnce(new Error("Reasoning is mandatory for this endpoint"))
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const pending = compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ compactionTimeoutReset, thinkLevel: "off" }),
    );
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

  it("keeps a timeout after summary generation as a failure instead of discarding it", async () => {
    const createAgentSession = createAgentSessionMock.getMockImplementation();
    if (!createAgentSession) {
      throw new Error("Expected a create-agent-session implementation");
    }
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
      const pending = compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({ trigger: "budget" }),
      );
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

  it("fails closed before generic compaction for a model-locked native session", async () => {
    const params = await nativeCompactionArgs({
      provider: "openai",
      model: "gpt-5.6-luna",
      agentHarnessId: "codex",
    });
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
    expect(resolveModelMock).not.toHaveBeenCalled();
    expect(sessionCompactImpl).not.toHaveBeenCalled();
  });

  it.each(["prepared runtime plan", "source-provider auth profile"] as const)(
    "discards the %s when compaction falls back across providers",
    async (source) => {
      const preparedPlan = source === "prepared runtime plan";
      const { runtimeAuthPlan, runtimePlan } = createPreparedCodexCompactionPlans();
      sessionCompactImpl.mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      );
      if (preparedPlan) {
        sessionCompactImpl.mockResolvedValueOnce({
          summary: "rebuilt fallback summary",
          firstKeptEntryId: "entry-fallback",
          tokensBefore: 120,
          details: { ok: true },
        });
      }
      const result = await compactEmbeddedAgentSessionDirect({
        ...wrappedCompactionArgs({ provider: "openai", model: "gpt-5.5" }),
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
              config: {
                agents: {
                  defaults: {
                    model: { primary: "openai/gpt-5.5", fallbacks: ["github-copilot/gpt-5.6-sol"] },
                  },
                },
              },
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

    await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
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
      }),
    );

    expect(
      getApiKeyForModelMock.mock.calls.map(
        ([params]) => (params as { profileId?: string }).profileId,
      ),
    ).toEqual(["openai:missing", "openai:backup"]);
    expect(
      resolveModelAsyncMock.mock.calls.some((call) => {
        const options = (call as unknown as readonly unknown[])[4] as
          | { authProfileId?: string }
          | undefined;
        return options?.authProfileId === "openai:backup";
      }),
    ).toBe(true);
    expect(
      resolveModelAsyncMock.mock.calls.some((call) => {
        const options = (call as unknown as readonly unknown[])[4] as
          | { authProfileId?: string }
          | undefined;
        return options?.authProfileId === "openai:missing";
      }),
    ).toBe(true);
    expect(resolveEmbeddedAgentStreamMock).toHaveBeenCalledWith(
      expect.objectContaining({ authProfileId: "openai:backup" }),
    );
    expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAuthProfileId: "openai:backup" }),
    );
  });

  it("uses sandboxSessionKey only for compaction sandbox resolution", async () => {
    const { addSession, deleteSession } = await import("../bash-process-registry.js");
    const owned = createProcessSessionFixture({ id: "compaction-owned", backgrounded: true });
    owned.scopeKey = "agent:main:main";
    const other = createProcessSessionFixture({ id: "policy-owned", backgrounded: true });
    other.scopeKey = "agent:main:telegram:default:direct:12345";
    addSession(owned);
    addSession(other);
    try {
      await compactEmbeddedAgentSessionDirect({
        sessionId: TEST_SESSION_ID,
        sessionKey: owned.scopeKey,
        sandboxSessionKey: other.scopeKey,
        sessionFile: TEST_SESSION_KEY,
        workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
      });

      expect(resolveSandboxContextMock).toHaveBeenCalledWith(
        expect.objectContaining({
          config: {},
          sessionKey: other.scopeKey,
          workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
        }),
      );
      expect(buildConfiguredAgentSystemPromptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeInfo: expect.objectContaining({
            activeProcessSessions: [expect.objectContaining({ sessionId: owned.id })],
          }),
        }),
      );
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
      await compactEmbeddedAgentSessionDirect({
        ...directCompactionArgs(),
        sessionKey,
        cwd: runtimeCwd,
      });
      expect(listRegisteredPluginAgentPromptGuidanceMock).toHaveBeenCalledWith({
        surface: promptSurface,
      });
      expect(buildConfiguredAgentSystemPromptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          promptMode,
          promptSurface,
          runtimeCwd,
          workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
          nativeCommandGuidanceLines: [guidance],
        }),
      );
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
              {
                name: "IDENTITY.md",
                path: "/ws/IDENTITY.md",
                content: "b".repeat(100),
                missing: false,
              },
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
    { execMode: "deny", permissionMode: "read-only", expectedExecMode: "deny" },
    { execMode: "allowlist", permissionMode: "guarded", expectedExecMode: "ask" },
    { execMode: "full", permissionMode: "full", expectedExecMode: "full" },
  ] as const)(
    "uses the final $permissionMode permission policy for compaction tools",
    async ({ execMode, permissionMode, expectedExecMode }) => {
      await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({
          workspaceDir: join(TEST_WORKSPACE_DIR, "workspace"),
          permissionMode: "full",
          sessionRoot: join(TEST_WORKSPACE_DIR, "workspace"),
          execOverrides: { mode: execMode },
          sessionEntry: {
            sessionId: TEST_SESSION_ID,
            permissionMode: "full",
            sessionRoot: join(TEST_WORKSPACE_DIR, "workspace"),
          },
        }),
      );

      const toolOptions = expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
        sessionPermissionPolicy: {
          mode: permissionMode,
          root: join(TEST_WORKSPACE_DIR, "workspace"),
        },
      });
      expect(toolOptions.exec).toEqual(expect.objectContaining({ mode: expectedExecMode }));
    },
  );

  it("defaults rootless compaction permissions to the canonical agent workspace", async () => {
    const workspaceDir = compactionFixture.makeTempDir("openclaw-rootless-compaction-permission-");
    const canonicalWorkspace = await realpath(workspaceDir);

    await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({
        workspaceDir,
        requireWorkspaceOnly: true,
        permissionMode: "workspace",
        sessionEntry: { sessionId: TEST_SESSION_ID, permissionMode: "workspace" },
      }),
    );

    const toolOptions = expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      sessionPermissionPolicy: { mode: "workspace", root: canonicalWorkspace },
      requireWorkspaceOnly: true,
    });
    expect(toolOptions.exec).toEqual(expect.objectContaining({ mode: "auto" }));
  });

  it("keeps manifest-profiled plugin tools executable during compaction", async () => {
    const toolName = "profiled_plugin_tool";
    const metadataSnapshot = {
      ...createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "profiled-plugin",
            origin: "workspace",
            rootDir: join(TEST_WORKSPACE_DIR, "workspace/profiled-plugin"),
            source: join(TEST_WORKSPACE_DIR, "workspace/profiled-plugin/index.js"),
            manifestPath: join(
              TEST_WORKSPACE_DIR,
              "workspace/profiled-plugin/openclaw.plugin.json",
            ),
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
      {
        name: toolName,
        label: "Profiled plugin tool",
        description: "Profiled plugin tool test fixture",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
      },
    ] as never);

    const result = await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
      config: { tools: { profile: "coding" } },
    });

    expect(result.ok).toBe(true);
    const toolOptions = expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {});
    expect(
      (toolOptions.preparedModelRuntime as { metadataSnapshot?: unknown }).metadataSnapshot,
    ).toBe(metadataSnapshot);
    expect(
      (
        toolOptions.conversationCapabilityProfile as {
          policy?: { explicitToolAllowlist?: string[] };
        }
      ).policy?.explicitToolAllowlist,
    ).toContain(toolName);
    const sessionOptions = expectRecordFields(mockCallArg(createAgentSessionMock), {});
    expect(sessionOptions.tools).toContain(toolName);
    expect(
      (sessionOptions.customTools as Array<{ name: string }>).map((tool) => tool.name),
    ).toContain(toolName);
  });

  it("skips runtime tool construction when the compaction model does not support tools", async () => {
    mockResolvedModel({ supportsTools: false });

    await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
    });

    expect(createOpenClawCodingToolsMock).not.toHaveBeenCalled();
  });

  it("quarantines unsupported tool schemas before creating the compaction model session", async () => {
    resolveContextEngineMock.mockResolvedValueOnce({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });
    resolveModelMock.mockImplementationOnce((provider = "openai", modelId = "fake") => ({
      logicalRef: { provider, model: modelId },
      model: { provider: "openai", api: "openai-responses", id: "fake", input: [] },
      error: null,
      authStorage: createCompactHooksAuthStorage(),
      modelRegistry: {},
    }));
    createOpenClawCodingToolsMock.mockReturnValueOnce([
      {
        name: "healthy_lookup",
        label: "Healthy Lookup",
        description: "Look up safe data.",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ text: "ok" }),
      },
      {
        name: "fuzzplugin_move_angles",
        label: "Fuzzplugin Move Angles",
        description: "Move robot joints.",
        parameters: { type: "array", items: { type: "number" } },
        execute: async () => ({ text: "bad" }),
      },
    ] as never);

    await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
      runId: "run-tool-schema-quarantine",
    });

    const sessionOptions = expectRecordFields(mockCallArg(createAgentSessionMock), {});
    expect(
      (sessionOptions.customTools as Array<{ name: string }>).map((tool) => tool.name),
    ).toEqual(["healthy_lookup"]);
    expect(sessionOptions.tools).toEqual(["healthy_lookup"]);
  });

  it("clamps the caller context token budget to the compaction model", async () => {
    resolveContextWindowInfoMock.mockReturnValueOnce({ tokens: 32_000 });

    await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
      contextTokenBudget: 64_000,
    });

    expectRecordFields(mockCallArg(createOpenClawCodingToolsMock), {
      modelContextWindowTokens: 32_000,
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
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "overflow fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });
    try {
      const result = await compactEmbeddedAgentSessionDirect({
        ...wrappedCompactionArgs({ provider, model: "primary" }),
        trigger: "overflow",
        modelFallbacksOverride: [`${provider}/entry`],
        config: {
          agents: { defaults: { model: { primary: `${provider}/primary`, fallbacks: [] } } },
          models: {
            providers: {
              [provider]: {
                auth: "api-key",
                apiKey: "synthetic-fixture",
                baseUrl: "http://127.0.0.1:1/v1",
                models: [],
              },
            },
          },
        },
      });
      expect(result, result.reason).toMatchObject({
        ok: true,
        result: { summary: "overflow fallback summary" },
      });
      expect(createAgentSessionMock.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ model: expect.objectContaining({ id: "primary" }) }),
        expect.objectContaining({ model: expect.objectContaining({ id: "middle" }) }),
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

  describe("safeguard failure provenance", () => {
    registerAgentSessionLoopTestLifecycle();
    const originalHistoryLimit = expectDefined(
      limitHistoryTurnsMock.getMockImplementation(),
      "history-limit fixture implementation",
    );

    let safeguard: typeof import("../agent-hooks/compaction-safeguard.js").default;
    let setSafeguardRuntime: typeof import("../agent-hooks/compaction-safeguard-runtime.js").setCompactionSafeguardRuntime;
    let summaryBridge: typeof import("../sessions/index.js").generateSummary;

    beforeAll(async () => {
      // The outer harness resets modules and mocks the session SDK. Retain the real
      // disposable session fixture above, but share the safeguard registry with the runner.
      safeguard = (await import("../agent-hooks/compaction-safeguard.js")).default;
      setSafeguardRuntime = (await import("../agent-hooks/compaction-safeguard-runtime.js"))
        .setCompactionSafeguardRuntime;
      summaryBridge = (await import("../sessions/index.js")).generateSummary;
    });

    afterEach(() => {
      vi.mocked(summaryBridge).mockReset().mockResolvedValue("summary");
      limitHistoryTurnsMock.mockImplementation(originalHistoryLimit);
    });

    it("returns a structured automatic retention skip without reporting compaction failure", async () => {
      const { isBenignCompactionSkipResult } = await import("./compact-reasons.js");
      const { createAgentSession } = await import("../sessions/sdk.js");
      const { guardSessionManager } = await import("../session-tool-result-guard-wrapper.js");
      const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
      const { attachCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const sessionManager = SessionManager.inMemory(TEST_WORKSPACE_DIR);
      sessionManager.appendMessage({ role: "user", content: "a".repeat(46_191), timestamp: 1 });
      const assistant = createAssistant(testModel, [{ type: "text", text: "ACK" }]);
      sessionManager.appendMessage({
        ...assistant,
        usage: { ...assistant.usage, input: 19_140, output: 2, totalTokens: 19_142 },
      });
      const pendingUserEntryId = sessionManager.appendMessage({
        role: "user",
        content: "b".repeat(52_602),
        timestamp: 3,
      });
      const contextEngineRuntimeContext = {};
      attachCompactionAccountingRecorder(contextEngineRuntimeContext, { pendingUserEntryId });
      const conversation = () =>
        sessionManager.getBranch().filter((entry) => entry.type === "message");
      const before = structuredClone(conversation());
      const stream = vi.fn<StreamFn>();
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
        streamFn: stream,
        strategy: "session-custom",
      });
      vi.mocked(createAgentSession).mockImplementation(async ({ model }) => {
        if (!model) {
          throw new Error("Expected prepared compaction model");
        }
        return await createTestSession({
          model: { ...testModel, ...model },
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { keepRecentTokens: 20_000 },
            retry: { enabled: false },
          }),
          resourceLoader: createResourceLoader(),
        });
      });
      const result = await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({ trigger: "budget", contextEngineRuntimeContext }),
      );
      expect(result).toMatchObject({
        ok: true,
        compacted: false,
        reason: "Nothing to compact (session too small)",
      });
      expect(isBenignCompactionSkipResult(result)).toBe(true);
      expect(conversation()).toEqual(before);
      expect(
        sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(stream).not.toHaveBeenCalled();
      expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
    });

    it.each([
      ["provider timeout", "request timed out", "fallback"],
      ["provider rate limit", "429 rate limit exceeded", "fallback"],
      ["intentional quality rejection", undefined, "cancel"],
      ["explicit model timeout", "request timed out", "cancel"],
      // A provider 408 is an actual summary timeout: commit without a summary, no model switch.
      ["provider 408", "408", "reduce"],
      // A failed corrective attempt stays a terminal quality cancellation, even on a 408.
      ["corrective 408", "408", "cancel"],
      [
        "reasoning-mandatory rejection",
        "400 Reasoning is mandatory for this endpoint and cannot be disabled.",
        "thinking",
      ],
    ] as const)(
      "keeps model fallback boundaries for %s",
      async (scenario, errorMessage, outcome) => {
        const [
          { createAgentSession },
          { guardSessionManager },
          { resolveEmbeddedAgentStream },
          { buildEmbeddedExtensionFactories },
        ] = await Promise.all([
          import("../sessions/sdk.js"),
          import("../session-tool-result-guard-wrapper.js"),
          import("./stream-resolution.js"),
          import("./extensions.js"),
        ]);
        const fallback = outcome === "fallback";
        const primary = "summary-primary";
        const backup = "summary-backup";
        const explicitModel = scenario === "explicit model timeout";
        const fallbackSummary = [
          "## Decisions",
          "Review the deployment checklist before rollout.",
          "## Open TODOs",
          "Compare the remaining options.",
          "## Constraints/Rules",
          "None.",
          "## Pending user asks",
          "Compare the remaining options.",
          "## Exact identifiers",
          "None.",
        ].join("\n");
        const expectedSummaryRequest = `Latest user request context: ${JSON.stringify("Keep the rollout notes.")}`;
        const sessionManager = SessionManager.inMemory(TEST_WORKSPACE_DIR);
        for (const content of [
          "Review the deployment checklist.",
          "Compare the remaining options.",
          "Keep the rollout notes.",
        ]) {
          sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
        }
        const originalMessages = sessionManager.buildSessionContext().messages;
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
          retry: { enabled: false },
        });
        const extension = await loadExtensionFromFactory(
          safeguard,
          TEST_WORKSPACE_DIR,
          createEventBus(),
          createExtensionRuntime(),
        );
        const requestedModels: string[] = [];
        const requestedThinking: Array<string | undefined> = [];
        const stream = vi.fn<StreamFn>((activeModel, _context, options) => {
          requestedModels.push(activeModel.id);
          requestedThinking.push(options?.reasoning);
          const corrective = scenario === "corrective 408";
          const rejected =
            activeModel.id === primary &&
            errorMessage &&
            !(outcome === "thinking" && options?.reasoning === "minimal") &&
            !(corrective && requestedModels.length === 1);
          return createAssistantResultStream(
            rejected
              ? { ...createAssistant(activeModel, [], "error"), errorMessage }
              : createAssistant(activeModel, [
                  {
                    type: "text",
                    text:
                      outcome === "cancel" || corrective
                        ? "Missing required sections."
                        : fallbackSummary,
                  },
                ]),
          );
        });
        vi.mocked(summaryBridge).mockImplementation(generateRealSummary);
        vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
        limitHistoryTurnsMock.mockImplementation((messages) => messages);
        resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");
        vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
          streamFn: stream,
          strategy: "session-custom",
        });
        vi.mocked(buildEmbeddedExtensionFactories).mockImplementation(({ model }) => {
          setSafeguardRuntime(sessionManager, {
            model,
            contextWindowTokens: 128_000,
            recentTurnsPreserve: 0,
            qualityGuardEnabled: true,
            qualityGuardMaxRetries: scenario === "corrective 408" ? 1 : 0,
          });
          return [];
        });
        vi.mocked(createAgentSession).mockImplementation(async ({ model, thinkingLevel }) => {
          if (!model) {
            throw new Error("Expected the prepared compaction model");
          }
          const created = await createTestSession({
            model: {
              ...testModel,
              ...model,
              reasoning: outcome === "thinking",
              maxTokens: 1_024,
            },
            sessionManager,
            settingsManager,
            resourceLoader: createResourceLoader(extension.handlers),
          });
          await created.session.setThinkingLevel(thinkingLevel ?? "off");
          return created;
        });
        const config = {
          agents: {
            defaults: {
              model: { primary: `openai/${primary}`, fallbacks: [`openai/${backup}`] },
              compaction: {
                mode: "safeguard" as const,
                thinkingLevel: "off" as const,
                ...(explicitModel ? { model: `openai/${primary}` } : {}),
                recentTurnsPreserve: 0,
                qualityGuard: { enabled: true, maxRetries: scenario === "corrective 408" ? 1 : 0 },
              },
            },
          },
        };
        const configBefore = structuredClone(config);

        const result = await compactEmbeddedAgentSessionDirect(
          wrappedCompactionArgs({
            provider: "openai",
            model: primary,
            trigger: "overflow",
            config,
          }),
        );

        expect([...new Set(requestedModels)], JSON.stringify(result)).toEqual(
          fallback ? [primary, backup] : [primary],
        );
        expect(config).toEqual(configBefore);
        if (outcome === "reduce") {
          expect(result).toMatchObject({ ok: true, compacted: true });
          expect(
            sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
          ).toMatchObject({ summary: expect.stringContaining("removed without a summary") });
        } else if (outcome !== "cancel") {
          if (outcome === "thinking") {
            expect([...new Set(requestedThinking)]).toEqual(["off", "minimal"]);
          }
          expect(result).toMatchObject({
            ok: true,
            compacted: true,
            result: { summary: expect.stringContaining(expectedSummaryRequest) },
          });
          expect(result.result?.summary).toContain(
            "Review the deployment checklist before rollout.",
          );
          expect(
            sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
          ).toMatchObject({
            summary: expect.stringContaining(expectedSummaryRequest),
            details: {
              latestUnresolvedUserRequest: "Keep the rollout notes.",
            },
          });
        } else {
          expect(result).toMatchObject({ ok: false, compacted: false });
          expect(result.reason).toMatch(explicitModel ? /timed out/i : /quality/i);
          expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(
            false,
          );
          expect(sessionManager.buildSessionContext().messages).toEqual(originalMessages);
        }
      },
    );
  });

  describe("progress-aware compaction watchdog", () => {
    registerAgentSessionLoopTestLifecycle();
    // compact.hooks.harness resolves every compaction watchdog to 30 s.
    const windowMs = 30_000;
    const ceilingMs = 10 * windowMs;
    // The trickle's last delta before the ceiling (280 s) leaves less than one window.
    const deltaEveryMs = 20_000;

    // Real host watchdog, runtime delegate, native watchdog, session and summarizer;
    // only the provider stream is scripted: one text delta every 20 s.
    async function compactWhileStreaming(deltas: number, end: "done" | "silent" | "keepalive") {
      const [
        { createAgentSessionForEmbeddedRunner },
        { guardSessionManager },
        { resolveEmbeddedAgentStream },
      ] = await Promise.all([
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
      vi.mocked(createAgentSessionForEmbeddedRunner).mockImplementation(async ({ model }) => {
        if (!model) {
          throw new Error("Expected the prepared compaction model");
        }
        return await createTestSession({
          model: { ...testModel, ...model },
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1_024, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
          resourceLoader: createResourceLoader(),
        });
      });
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: (params: Parameters<ContextEngine["compact"]>[0]) =>
          delegateCompactionToRuntime(params),
      } as never);

      vi.useFakeTimers();
      let settled = false;
      const pending = compactEmbeddedAgentSession(wrappedCompactionArgs()).finally(() => {
        settled = true;
      });
      void pending.catch(() => undefined);
      await streamStarted.promise;
      return { pending, stream, settled: () => settled };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps a request alive while it streams for longer than the window", async () => {
      const run = await compactWhileStreaming(10, "done");
      await vi.advanceTimersByTimeAsync(11 * deltaEveryMs);

      await expect(run.pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(run.stream).toHaveBeenCalledOnce();
    });

    it.each(["silent", "keepalive"] as const)(
      "stops a request one window after its last output delta (%s)",
      async (end) => {
        const run = await compactWhileStreaming(5, end);
        await vi.advanceTimersByTimeAsync(5 * deltaEveryMs + windowMs - 1);
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        await expect(run.pending).resolves.toMatchObject({
          ok: false,
          compacted: false,
          reason: expect.stringContaining("timed out"),
        });
        expect(run.stream).toHaveBeenCalledOnce();
      },
    );

    it("stops a stream that never goes silent at the total ceiling", async () => {
      const run = await compactWhileStreaming(Number.POSITIVE_INFINITY, "done");
      await vi.advanceTimersByTimeAsync(ceilingMs - 1);
      expect(run.settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(run.pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: expect.stringContaining("timed out"),
      });
      expect(run.stream).toHaveBeenCalledOnce();
    });
  });

  it.each([
    { source: "workspace manifest", fallback: "anthropic/legacy", modelId: "claude-modern" },
    { source: "configured alias", fallback: "summary-backup", modelId: "claude-fallback" },
  ])("plans canonical fallback plugins from the $source", async ({ source, fallback, modelId }) => {
    const config: OpenClawConfig =
      source === "configured alias"
        ? {
            agents: {
              defaults: { models: { "anthropic/claude-fallback": { alias: "summary-backup" } } },
            },
          }
        : {};
    const metadataSnapshot =
      source === "workspace manifest"
        ? {
            ...createPluginMetadataSnapshotFixture({
              plugins: [
                {
                  id: "compaction-normalizer",
                  providers: ["anthropic"],
                  origin: "workspace",
                  rootDir: TEST_WORKSPACE_DIR,
                  source: `${TEST_WORKSPACE_DIR}/index.js`,
                  manifestPath: `${TEST_WORKSPACE_DIR}/openclaw.plugin.json`,
                  modelIdNormalization: {
                    providers: { anthropic: { aliases: { legacy: "claude-modern" } } },
                  },
                },
              ],
            }),
            configFingerprint: "workspace-compaction-normalization",
          }
        : undefined;
    const result = await compactEmbeddedAgentSessionDirect({
      ...wrappedCompactionArgs({ provider: "openai", model: "gpt-primary" }),
      agentHarnessId: "codex",
      modelFallbacksOverride: [fallback],
      config,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(plannedCompactionPluginSelections(config, metadataSnapshot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", modelId, runtime: "codex" }),
      ]),
    );
    if (source === "configured alias") {
      const admittedConfig = {
        agents: {
          defaults: {
            ...config.agents?.defaults,
            compaction: { model: "anthropic/reloaded-summary" },
          },
        },
      };
      expect(plannedCompactionPluginSelections(admittedConfig)).toContainEqual(
        expect.objectContaining({
          provider: "anthropic",
          modelId: "reloaded-summary",
          runtime: "codex",
        }),
      );
    }
  });

  it("revalidates immutable Ultra for each compaction fallback candidate", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "openclaw" });
    sessionCompactImpl
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });
    const params = {
      ...directCompactionArgs(),
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: "ultra" as const,
      trigger: "overflow" as const,
      modelFallbacksOverride: ["demo/basic"],
      config: {
        agents: {
          defaults: {
            compaction: { thinkingLevel: "inherit" as const },
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
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

  it("preserves Codex OAuth across same-provider OpenAI compaction fallbacks", async () => {
    mockResolvedModel();
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
      .mockRejectedValueOnce(
        Object.assign(new Error("primary compaction rate limited"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
      )
      .mockResolvedValueOnce({
        summary: "oauth fallback summary",
        firstKeptEntryId: "entry-fallback",
        tokensBefore: 120,
        details: { ok: true },
      });

    const result = await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:default",
      trigger: "overflow",
      modelFallbacksOverride: ["openai/gpt-5.4-mini"],
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: [],
            },
          },
        },
      } as never,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.summary).toBe("oauth fallback summary");
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

  it("applies validated transcript before hooks even when it becomes empty", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    const { sanitizeSessionHistory } = await import("./replay-history.js");
    vi.mocked(sanitizeSessionHistory).mockResolvedValueOnce([]);

    const result = await compactEmbeddedAgentSessionDirect(wrappedCompactionArgs());

    expect(result.ok).toBe(true);

    const beforeContext = sessionHook("compact:before")?.context;
    expectRecordFields(beforeContext, {
      messageCountOriginal: 0,
      tokenCountOriginal: 0,
      messageCount: 0,
      tokenCount: 0,
    });
  });

  it("forwards internal compaction hook messages to the caller", async () => {
    const onHookMessages = vi.fn();
    triggerInternalHookMock.mockImplementation((event: unknown) => {
      const hookEvent = event as { action?: string; messages?: string[] };
      hookEvent.messages?.push(`${hookEvent.action} notice`);
    });
    await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ onCompactionHookMessages: onHookMessages }),
    );

    expect(onHookMessages).toHaveBeenNthCalledWith(1, {
      phase: "before",
      messages: ["compact:before notice"],
      sessionId: TEST_SESSION_ID,
      sessionKey: "agent:main:session-1",
    });
    expect(onHookMessages).toHaveBeenNthCalledWith(2, {
      phase: "after",
      messages: ["compact:after notice"],
      sessionId: TEST_SESSION_ID,
      sessionKey: "agent:main:session-1",
    });
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

    expect(beforeMetrics.tokenCountOriginal).toBeUndefined();
    expect(beforeMetrics.tokenCountBefore).toBeUndefined();
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

    const resolveAgentArg = mockCallArg(resolveSessionAgentIdMock) as Record<string, unknown>;
    expectRecordFields(resolveAgentArg, { sessionKey: TEST_SESSION_KEY });
    expect(resolveAgentArg.config).toBeTypeOf("object");
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it.each(["await", "async"] as const)(
    "settles post-compaction memory sync in %s mode",
    async (mode) => {
      const syncStarted = createDeferred<PostCompactionSyncParams>();
      const syncRelease = createDeferred();
      const sync = vi.fn<PostCompactionSync>(async (params) => {
        syncStarted.resolve(params as PostCompactionSyncParams);
        await syncRelease.promise;
      });
      const managerRequested = createDeferred();
      const managerGate = createDeferred<{ manager: { sync: PostCompactionSync } }>();
      getMemorySearchManagerMock.mockImplementation(async () => {
        managerRequested.resolve(undefined);
        return mode === "async" ? await managerGate.promise : { manager: { sync } };
      });
      let settled = false;
      const resultPromise = compactTesting.runPostCompactionSideEffects({
        config: compactionConfig(mode),
        sessionKey: TEST_SESSION_KEY,
        sessionFile: TEST_SESSION_FILE,
      });
      void resultPromise.then(() => {
        settled = true;
      });
      await managerRequested.promise;
      if (mode === "async") {
        await resultPromise;
        expect(getMemorySearchManagerMock).toHaveBeenCalledTimes(1);
        expect(settled).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        managerGate.resolve({ manager: { sync } });
      }
      await expect(syncStarted.promise).resolves.toEqual({
        archiveFiles: [TEST_SESSION_FILE],
        reason: "post-compaction",
      });
      expect(settled).toBe(mode === "async");
      syncRelease.resolve(undefined);
      await resultPromise;
      expect(settled).toBe(true);
    },
  );

  registerDirectProviderRefreshTests({
    compactTesting: () => compactTesting,
    compactionConfig,
    sessionKey: TEST_SESSION_KEY,
    sessionFile: () => TEST_SESSION_FILE,
  });
  it.each(["budget"] as const)(
    "carries the pending request into safeguard %s recovery after endpoint fallback",
    async (trigger) => {
      const { attachCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const contextEngineRuntimeContext = {};
      if (trigger === "budget") {
        attachCompactionAccountingRecorder(contextEngineRuntimeContext, {
          pendingRequestState: "unresolved",
        });
      }
      resolveEffectiveCompactionModeMock.mockReturnValue("safeguard");

      const result = await compactEmbeddedAgentSessionDirect(
        wrappedCompactionArgs({ trigger, contextEngineRuntimeContext }),
      );

      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(sessionAutomaticCompactionMock).toHaveBeenCalledWith(
        TEST_CUSTOM_INSTRUCTIONS,
        "unresolved",
        "none",
      );
      expect(sessionManualCompactionMock).not.toHaveBeenCalled();
    },
  );

  it("carries the prepared provider reconciler into direct compaction", async () => {
    mockResolvedModel();
    const reconcile = vi.fn(async () => undefined);
    const { resolvePreparedProviderRuntimeHandle } = await import("../runtime-plan/build.js");
    vi.mocked(resolvePreparedProviderRuntimeHandle).mockImplementationOnce((params) => ({
      provider: params.provider,
      modelId: params.modelId,
      workspaceDir: params.workspaceDir,
      prepared: true,
      plugin: { id: params.provider, label: "Fixture", auth: [], reconcileLocalService: reconcile },
    }));

    await expect(compactEmbeddedAgentSessionDirect(wrappedCompactionArgs())).resolves.toMatchObject(
      { ok: true },
    );

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

    const result = await compactEmbeddedAgentSessionDirect(
      wrappedCompactionArgs({ trigger: "overflow" }),
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sessionCompactImpl).toHaveBeenCalledOnce();
  });

  it("preserves explicit compaction.model behavior without session fallback", async () => {
    sessionCompactImpl.mockRejectedValueOnce(
      Object.assign(new Error("400 invalid request body"), { status: 400 }),
    );

    const result = await compactEmbeddedAgentSessionDirect({
      ...directCompactionArgs(),
      provider: "openai",
      model: "gpt-primary",
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-primary",
              fallbacks: ["anthropic/claude-fallback"],
            },
            compaction: {
              model: "azure/compact-primary",
            },
          },
        },
      } as never,
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
      id: "claude-cli",
      ownsNativeCompaction: true,
      manualCompaction: {
        buildPrompt: () => "/compact",
        input: "arg",
        validateOutput: () => ({ ok: true }),
      },
      config: {
        command: "claude",
        args: ["-p"],
        resumeArgs: ["-p", "--resume", "{sessionId}"],
        input: "arg",
        output: "jsonl",
        sessionMode: "existing",
      },
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

  function mockQueuedRouteAwareModel(
    defaultApi: "openai-responses" | "openai-chatgpt-responses" = "openai-responses",
  ) {
    resolveModelMock.mockImplementation(
      (provider = "openai", modelId = "gpt-5.5", _agentDir?: string, cfg?: unknown) => {
        const providerConfig = (
          cfg as
            | {
                models?: {
                  providers?: Record<string, { api?: string; baseUrl?: string }>;
                };
              }
            | undefined
        )?.models?.providers?.[provider];
        const api = providerConfig?.api ?? defaultApi;
        const subscription = api === "openai-chatgpt-responses";
        return {
          logicalRef: { provider, model: modelId },
          model: {
            provider,
            id: modelId,
            api,
            baseUrl:
              providerConfig?.baseUrl ??
              (subscription
                ? "https://chatgpt.com/backend-api/codex"
                : "https://api.openai.com/v1"),
            contextWindow: subscription ? 272_000 : 1_050_000,
            input: [],
          },
          error: null,
          authStorage: createCompactHooksAuthStorage(),
          modelRegistry: {},
        };
      },
    );
  }

  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.runBeforeCompaction.mockReset();
    hookRunner.runAfterCompaction.mockReset();
    resolveContextEngineMock.mockReset();
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: true },
      compact: contextEngineCompactMock,
    });
    contextEngineCompactMock.mockReset();
    contextEngineCompactMock.mockResolvedValue({
      ok: true,
      compacted: true,
      reason: undefined,
      result: { summary: "engine-summary", tokensBefore: 120, tokensAfter: 50 },
    });
    mockResolvedModel();
    mockQueuedRouteAwareModel();
  });

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
    const blocker = queue.enqueueCommandInLane(blockedLane, () => release.promise);
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
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: contextEngineCompactMock,
      });
      maybeCompactAgentHarnessSessionMock.mockResolvedValue({ ok: true, compacted: false });
    }
    const params =
      route === "native"
        ? await nativeCompactionArgs({
            ...overrides,
            agentHarnessId: "codex",
            provider: "openai",
            model: "gpt-5.5",
          })
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
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      controller.abort(new Error("Foreground turn preempted queued maintenance"));
      expect(queue.getCommandLaneSnapshot(blockedLane).queuedCount).toBe(0);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        compacted: false,
        reason: "compaction aborted",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, pending]);
    }
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
  });

  it("drains committed maintenance before rejecting a manual request pinned to its predecessor", async () => {
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
      await expect(pending).rejects.toThrow("session writer claim changed");
      await settled;
      expect(events).toEqual(["maintenance cleanup finished", "manual rejected"]);
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      expect(runCliAgentMock).not.toHaveBeenCalled();
      expect(loadSessionEntryReadOnly(successorTarget)).toEqual(acceptedEntry);
      expect(await loadTranscriptEvents(successorTarget)).toEqual(transcriptBefore);
    } finally {
      releaseCleanup.resolve();
      await Promise.allSettled([maintenance, pending, settled]);
    }
  });

  it("reports target-only cancellation during prepared runtime lease admission", async () => {
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

    const pending = compactEmbeddedAgentSession(
      wrappedCompactionArgs({ abortSignal: sourceController.signal, trigger: "manual" }),
    );
    const admittedSignal = expectDefined(
      await admissionStarted.promise,
      "prepared runtime lease admission signal",
    );
    expect(abortEmbeddedAgentRun(TEST_SESSION_ID)).toBe(true);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      compacted: false,
      reason: "compaction aborted",
    });
    expect(sourceController.signal.aborted).toBe(false);
    expect(admittedSignal.aborted).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
  });

  it("stops preparation when host authority expires during model resolution before route rematerialization", async () => {
    const modelResolutionStarted = createDeferred();
    const releaseModelResolution = createDeferred();
    const authStorage = createCompactHooksAuthStorage();
    let hostActive = true;
    resolveModelAsyncMock.mockImplementationOnce(async (provider, modelId) => {
      modelResolutionStarted.resolve(undefined);
      await releaseModelResolution.promise;
      return {
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
    expect(selectAgentHarnessForPreparedModelProvidersMock).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
    expect(enqueueCommandInLaneMock).not.toHaveBeenCalled();
  });

  it("disposes the context engine safely when primary native compaction throws", async () => {
    const dispose = vi.fn(async () => {
      throw new Error("dispose failed");
    });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
      dispose,
    } as never);
    maybeCompactAgentHarnessSessionMock.mockRejectedValueOnce(
      new Error("native compaction failed"),
    );

    await expect(
      compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
        }),
      ),
    ).rejects.toThrow("native compaction failed");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(enqueueCommandInLaneMock).toHaveBeenCalledOnce();
  });

  it.each([
    { outcome: "waits for the active session lane", writerRunId: undefined },
    { outcome: "rejects a replaced writer claim", writerRunId: "replacement-run" },
  ])("shipped /compact $outcome before native compaction", async ({ writerRunId }) => {
    const command = await import("../../auto-reply/reply/commands-compact.test-support.js");
    vi.mocked(command.compactEmbeddedAgentSession).mockReset();
    await nativeCompactionArgs({ agentHarnessId: "codex" });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });
    const laneRelease = createDeferred();
    const laneEntered = createDeferred();
    enqueueCommandInLaneMock.mockImplementationOnce(async (_lane, task) => {
      laneEntered.resolve();
      await laneRelease.promise;
      return await task();
    });
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
        provider: "openai",
        model: "gpt-5.5",
        workspaceDir: TEST_WORKSPACE_DIR,
        agentDir: join(TEST_WORKSPACE_DIR, "agents/main/agent"),
        sessionEntry: {
          sessionId: TEST_SESSION_ID,
          updatedAt: Date.now(),
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        },
      },
      true,
    );
    await laneEntered.promise;
    expect(enqueueCommandInLaneMock).toHaveBeenCalledOnce();
    expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();

    if (writerRunId) {
      await patchSessionEntryCore(
        {
          agentId: "main",
          sessionKey: TEST_SESSION_KEY,
          storePath: TEST_STORE_PATH,
        },
        (entry) => ({ ...entry, activeWriterRunId: writerRunId }),
      );
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

  it("preserves a summaryless server-endpoint result through the legacy engine delegate", async () => {
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: contextEngineCompactMock,
    });
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

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({ provider: "xai", model: "grok-4.5" }),
    );

    expect(result.compactionKind).toBe("server-endpoint");
    expect(result.result).toMatchObject({ kind: "server-endpoint", tokensAfter: 200 });
    expect(result.result).not.toHaveProperty("summary");
  });

  it("does not impose a second aggregate timeout on delegated native compaction", async () => {
    const { compactionWatchdogResets } =
      await import("../../context-engine/compaction-watchdog.js");
    const started = createDeferred<() => void>();
    const terminal = createDeferred<Awaited<ReturnType<ContextEngine["compact"]>>>();
    // Stand in for the runtime delegate: it finds the reset through the host signal.
    const compact = vi.fn<ContextEngine["compact"]>(async ({ abortSignal }) => {
      const resetTimeout = abortSignal && compactionWatchdogResets.get(abortSignal);
      if (!resetTimeout) {
        throw new Error("Delegated compaction must receive its progress reset callback");
      }
      started.resolve(resetTimeout);
      return await terminal.promise;
    });
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact,
    });
    vi.useFakeTimers();
    let settled = false;
    const pending = compactEmbeddedAgentSession(wrappedCompactionArgs()).finally(() => {
      settled = true;
    });
    void pending.catch(() => undefined);
    try {
      const resetTimeout = await Promise.race([
        started.promise,
        pending.then(() => {
          throw new Error("Compaction settled before the delegate started");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      resetTimeout();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      terminal.resolve({
        ok: true,
        compacted: true,
        result: { summary: "engine-summary", tokensBefore: 120, tokensAfter: 50 },
      });

      await expect(pending).resolves.toMatchObject({ ok: true, compacted: true });
      expect(compact).toHaveBeenCalledOnce();
    } finally {
      terminal.resolve({ ok: false, compacted: false });
      await pending.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("emits a transcript update and post-compaction memory sync on the engine-owned path", async () => {
    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    const sync = vi.fn(async () => {});
    getMemorySearchManagerMock.mockResolvedValue({ manager: { sync } });

    try {
      const result = await compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          sessionFile: `  ${TEST_SESSION_FILE}  `,
          config: compactionConfig("await"),
        }),
      );

      expect(result.ok).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        agentId: "main",
        sessionKey: TEST_SESSION_KEY,
        sessionId: TEST_SESSION_ID,
        target: {
          agentId: "main",
          sessionId: TEST_SESSION_ID,
          sessionKey: TEST_SESSION_KEY,
        },
      });
      expect(sync).toHaveBeenCalledWith({
        reason: "post-compaction",
        sessions: [
          {
            agentId: "main",
            sessionId: TEST_SESSION_ID,
            sessionKey: TEST_SESSION_KEY,
          },
        ],
      });
    } finally {
      cleanup();
    }
  });

  it("keeps authorized host byte compaction successful when secondary Codex sync fails", async () => {
    const order: string[] = [];
    const registry = requireActivePluginRegistry();
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("not used");
      },
    };
    withPluginRegistrationContext(registry, "codex", () => {
      registerAgentHarness(harness, {
        nativeCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
      });
    });
    const registeredHarness = expectDefined(
      getRegisteredAgentHarness("codex")?.harness,
      "registered Codex harness",
    );
    const acquirePreparedRuntime = expectDefined(
      acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
      "prepared runtime acquisition",
    );
    acquireAgentRunPreparedModelRuntimeMock.mockImplementationOnce(async (input) => {
      const lease = await acquirePreparedRuntime(input);
      return {
        ...lease,
        snapshot: { ...lease.snapshot, pluginRegistry: registry },
      };
    });
    selectAgentHarnessMock.mockReturnValue(registeredHarness);
    selectAgentHarnessForPreparedModelProvidersMock.mockReturnValue(registeredHarness);
    resolveContextEngineMock.mockResolvedValue({
      info: { id: "legacy", name: "Legacy", version: "1.0.0" },
      compact: (params: Parameters<NonNullable<ContextEngine["compact"]>>[0]) =>
        delegateCompactionToRuntime(params),
    } as never);
    sessionCompactImpl.mockImplementationOnce(async () => {
      order.push("host");
      return {
        summary: "host-summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 50,
        details: { ok: true },
      };
    });
    maybeCompactAgentHarnessSessionMock.mockImplementationOnce(async () => {
      order.push("native");
      return {
        ok: false,
        compacted: false,
        reason: "provider_error_4xx",
        failure: {
          reason: "provider_error_4xx",
          status: 400,
          rawError: "provider_error_4xx",
        },
      };
    });

    const result = await compactEmbeddedAgentSession(
      await nativeCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        trigger: "budget",
        forcePreflight: true,
        preflightRequired: true,
        preflightCompactionTrigger: "transcript_bytes",
      }),
      { transcriptBytePreflightHarness: "codex" },
    );

    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      result: {
        summary: "host-summary",
        details: {
          codexNativeCompaction: {
            ok: false,
            compacted: false,
            reason: "provider_error_4xx",
            failure: { reason: "provider_error_4xx", status: 400 },
          },
        },
      },
    });
    expect(order).toEqual(["host", "native"]);
    expect(attemptServerEndpointCompactionMock).not.toHaveBeenCalled();
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentHarnessId: "codex" }),
      expectedNativeCompactionOptions("after_context_engine"),
    );
  });

  it("keeps cross-route direct fallback available through queued legacy compaction", async () => {
    const authStore = {
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
    };
    ensureAuthProfileStoreMock.mockReturnValue(authStore);
    getApiKeyForModelMock.mockImplementation(async (authParams = {}) => {
      if (authParams.profileId === "openai:subscription") {
        throw new Error("subscription credential resolution failed");
      }
      if (authParams.allowAuthProfileFallback === false) {
        return { apiKey: "literal-key", mode: "api-key", source: "models.json" };
      }
      throw new Error("unexpected auth lookup");
    });
    const legacyCompact: ContextEngine["compact"] = (params) => delegateCompactionToRuntime(params);
    resolveContextEngineMock.mockResolvedValue({
      info: { ownsCompaction: false },
      compact: legacyCompact,
    } as never);

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        config: {
          models: {
            providers: {
              openai: {
                apiKey: "literal-key",
                models: [{ id: "gpt-5.5" }],
              },
            },
          },
        },
      }),
    );

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

  it("reports cancellation while queued native CLI compaction is in flight", async () => {
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
    await expect(pending).resolves.toEqual({
      ok: false,
      compacted: false,
      reason: "compaction aborted",
    });
    expect(nativeSignal.aborted).toBe(true);
    expect(nativeSignal.reason).toBe(cancellation);
    expect(resolveContextEngineMock).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
  });

  it("rejects a replaced writer claim before queued native CLI compaction", async () => {
    const laneEntered = createDeferred();
    const laneRelease = createDeferred();
    enqueueCommandInLaneMock.mockImplementationOnce(async (_lane, task) => {
      laneEntered.resolve();
      await laneRelease.promise;
      return await task();
    });
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

  it("materializes the selected route before deriving compaction context budget", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    resolveContextWindowInfoMock.mockImplementation((input?: { modelContextWindow?: number }) => ({
      tokens: input?.modelContextWindow ?? 128_000,
    }));
    ensureAuthProfileStoreMock.mockReturnValue({
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "subscription-token",
        },
      },
      order: { openai: ["openai:token"] },
    });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        authProfileId: "openai:token",
        authProfileIdSource: "auto",
        agentHarnessId: "codex",
      }),
    );

    expect(mockCallArg(resolveModelAsyncMock, 0, 4)).toEqual(
      expect.objectContaining({ authProfileId: "openai:token" }),
    );
    expect(resolveModelAsyncMock).toHaveBeenLastCalledWith(
      "openai",
      "gpt-5.5",
      expect.any(String),
      expect.objectContaining({
        models: {
          providers: {
            openai: expect.objectContaining({
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            }),
          },
        },
      }),
      expect.objectContaining({ authProfileMode: "token" }),
    );
    expect(contextEngineCompactMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBudget: 272_000 }),
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authProfileId: "openai:token",
        authProfileIdSource: "auto",
        contextTokenBudget: 272_000,
        runtimeModel: expect.objectContaining({
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          contextWindow: 272_000,
        }),
        runtimeAuthPlan: undefined,
      }),
      expectedNativeCompactionOptions("after_context_engine"),
    );
  });

  it("uses a prepared harness binding for queued custom OpenAI Responses compaction", async () => {
    const modelRoute = {
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    } as const;
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      harnessAuthProvider: "openai",
      selectedAuthMode: "api-key",
      modelRoute,
    } as const;
    resolveAgentHarnessPolicyMock.mockReturnValue({ runtime: "codex" });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "harness",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
    });

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        runtimeAuthPlan,
        config: {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://example.test/v1",
                models: [{ id: "gpt-5.5", contextWindow: 350_000 }],
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(mockCallArg(resolveModelMock)).toBe("openai");
    expectRecordFields(mockCallArg(resolveContextWindowInfoMock), {
      provider: "openai",
      modelId: "gpt-5.5",
    });
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        runtimeModel: expect.objectContaining({
          api: "openai-responses",
          baseUrl: "https://example.test/v1",
        }),
        runtimeAuthPlan: expect.objectContaining({ modelRoute }),
      }),
      expectedNativeCompactionOptions("after_context_engine"),
    );
    const compactArg = mockCallArg(contextEngineCompactMock) as {
      runtimeContext?: Record<string, unknown>;
    };
    expectRecordFields(compactArg.runtimeContext, {
      provider: "openai",
      runtimeProvider: undefined,
      model: "gpt-5.5",
    });
  });

  it("fails deferred budget compaction when background maintenance is not scheduled", async () => {
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

    const result = await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        trigger: "budget",
        deferOwningContextEngineCompaction: true,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("failed to schedule background context-engine maintenance");
    expect(result.failure?.reason).toBe("deferred_compaction_not_scheduled");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(maintain).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      agentHarnessId: "codex",
      failureReason: "stale_thread_binding",
      reason: "codex app-server binding changed before native compaction",
      nativeCapabilityUsed: true,
    },
    {
      agentHarnessId: "copilot",
      failureReason: "missing_thread_binding",
      reason: "no copilot app-server thread binding",
      nativeCapabilityUsed: false,
    },
  ])(
    "permits locked $agentHarnessId preflight fallback only after native capability use",
    async ({ agentHarnessId, failureReason, reason, nativeCapabilityUsed }) => {
      if (nativeCapabilityUsed) {
        resolveContextEngineMock.mockResolvedValue({
          info: { ownsCompaction: false },
          compact: contextEngineCompactMock,
        });
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
      const result = await compactEmbeddedAgentSession(
        await nativeCompactionArgs({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId,
          trigger: "budget",
          preflightRequired: true,
          ...(nativeCapabilityUsed
            ? {
                config: {
                  models: {
                    providers: { openai: { models: [{ id: "gpt-5.5", contextWindow: 350_000 }] } },
                  },
                },
              }
            : {}),
        }),
      );
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
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openai",
          model: "gpt-5.5",
          agentHarnessId,
          preflightRequired: true,
        }),
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
      const result = await compactEmbeddedAgentSession(
        await nativeCompactionArgs({
          provider: "openai",
          model,
          agentHarnessId,
          currentTokenCount: 333,
        }),
      );
      expect(result).toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: "model_selection_locked" },
      });
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledTimes(nativeCalls);
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
    },
  );

  it("runs native manual compaction before generic model auth preparation", async () => {
    const result = await compactEmbeddedAgentSession(
      await nativeCompactionArgs({ ...nativeCliArgs(), agentHarnessId: "claude-cli" }),
    );
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ cliSessionId: "native-session", controlOperation: "compact" }),
    );
    expect(acquireAgentRunPreparedModelRuntimeMock).not.toHaveBeenCalled();
    expect(contextEngineCompactMock).not.toHaveBeenCalled();
  });

  it("holds the queued lane until secondary Codex compaction reaches its terminal event", async () => {
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
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
    const resultPromise = compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "codex",
        model: "gpt-5.4",
        agentHarnessId: "codex",
        trigger: "budget",
      }),
    ).finally(() => {
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

  it("surfaces a hung/throwing engine compact() as a clean ok:false result", async () => {
    hookRunner.hasHooks.mockReturnValue(true);
    contextEngineCompactMock.mockRejectedValue(new Error("Compaction timed out after 900000ms"));

    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs());

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("timed out");
    expect(hookRunner.runAfterCompaction).not.toHaveBeenCalled();
  });

  it("skips a faulty compacting probe and cancels the live compaction behind it", async () => {
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
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({ trigger: "manual" }),
      );
      await pending.started.promise;
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);

      // An unreadable compaction state fails closed: the caller keeps the same
      // structured rejection a genuinely compacting run returns, and the probe
      // exception never reaches the steering caller.
      await expect(
        queueEmbeddedAgentMessageWithOutcomeAsync("session-faulty-probe", "steer"),
      ).resolves.toMatchObject({ queued: false, reason: "compacting" });
      await expect(
        queueEmbeddedAgentMessageWithOutcomeAsync(TEST_SESSION_ID, "steer"),
      ).resolves.toMatchObject({ queued: false, reason: "compacting" });

      // A restart sweep walks past the unreadable handle and cancels the
      // compaction that is really running behind it.
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
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction },
        compact: contextEngineCompactMock,
      });
      resolveAgentHarnessPolicyMock.mockReturnValue({
        runtime: "codex",
        runtimeSource: "model",
      } as never);
      const pending = mockPendingNativeCompaction();
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          provider: "openai",
          model: "gpt-5.4",
          agentHarnessId: "codex",
          trigger: "manual",
        }),
      );

      await pending.started.promise;
      const aborted =
        abortReason === "restart"
          ? abortEmbeddedAgentRun(undefined, { mode: "compacting", reason: "restart" })
          : abortEmbeddedAgentRun(TEST_SESSION_ID);
      expect(aborted).toBe(true);
      expect(pending.signal?.reason).toBe(abortReason);
      pending.terminal.resolve({ ok: false, compacted: false, reason: "aborted" });

      await expect(resultPromise).resolves.toMatchObject({ ok: resultOk });
      expect(contextEngineCompactMock).toHaveBeenCalledTimes(ownsCompaction ? 1 : 0);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    },
  );

  it("registers manual compaction alongside its active reply operation", async () => {
    const replyOperation = createReplyOperation({
      sessionKey: TEST_SESSION_KEY,
      sessionId: TEST_SESSION_ID,
      resetTriggered: false,
    });
    replyOperation.setPhase("preflight_compacting");
    expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
    expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
    const pending = mockPendingContextEngineCompaction();

    try {
      const resultPromise = compactEmbeddedAgentSession(
        wrappedCompactionArgs({
          abortSignal: replyOperation.abortSignal,
          trigger: "manual",
        }),
      );

      await pending.started.promise;
      expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(true);
      expect(replyOperation.abortByUser()).toBe(true);
      expect(pending.signal?.aborted).toBe(true);
      expect(pending.signal?.reason).toBe(replyOperation.abortSignal.reason);
      pending.release.resolve(undefined);

      await expect(resultPromise).resolves.toMatchObject({ ok: false, compacted: false });
      expect(isEmbeddedAgentRunHandleActive(TEST_SESSION_ID)).toBe(false);
      expect(isEmbeddedAgentRunActive(TEST_SESSION_ID)).toBe(true);
    } finally {
      replyOperation.complete();
    }
  });

  it.each([
    {
      identity: "session key",
      activeSessionKey: TEST_SESSION_KEY,
      activeSessionFile: "other-session.jsonl",
    },
    {
      identity: "session file",
      activeSessionKey: "agent:main:other-session",
      activeSessionFile: TEST_SESSION_KEY,
    },
  ])("rejects manual compaction matching an active $identity", async (active) => {
    const activeSessionId = "other-session";
    const activeSessionFile =
      active.activeSessionFile === TEST_SESSION_KEY
        ? TEST_SESSION_KEY
        : join(TEST_WORKSPACE_DIR, active.activeSessionFile);
    const existingHandle = {
      kind: "embedded" as const,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(
      activeSessionId,
      existingHandle,
      active.activeSessionKey,
      activeSessionFile,
    );
    try {
      await expect(
        compactEmbeddedAgentSession(wrappedCompactionArgs({ trigger: "manual" })),
      ).resolves.toMatchObject({
        ok: false,
        compacted: false,
        failure: { reason: "active_run" },
      });
      expect(contextEngineCompactMock).not.toHaveBeenCalled();
      expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      expect(isEmbeddedAgentRunHandleActive(activeSessionId)).toBe(true);
    } finally {
      clearActiveEmbeddedRun(
        activeSessionId,
        existingHandle,
        active.activeSessionKey,
        activeSessionFile,
      );
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
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: contextEngineCompactMock,
      });
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
        await expect(
          compactEmbeddedAgentSession(wrappedCompactionArgs({ sessionTarget: activeTarget })),
        ).rejects.toThrow("successor identity is inconsistent");
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

    const result = await compactEmbeddedAgentSession(wrappedCompactionArgs());

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(contextEngineCompactMock).toHaveBeenCalledTimes(1);
  });
  it("prepares queued native harness auth without a host profile", async () => {
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    resolveAgentHarnessPolicyMock.mockReturnValue({
      runtime: "codex",
      runtimeSource: "model",
    } as never);
    ensureAuthProfileStoreMock.mockReturnValue({ version: 1, profiles: {} });
    maybeCompactAgentHarnessSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: { summary: "harness", firstKeptEntryId: "entry-1", tokensBefore: 100 },
    });

    await compactEmbeddedAgentSession(
      wrappedCompactionArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      }),
    );

    expect(selectAgentHarnessForPreparedModelProvidersMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProviders: expect.arrayContaining([
          expect.objectContaining({
            preparedAuth: expect.objectContaining({ source: "harness" }),
            runtimePolicy: expect.objectContaining({ compatibleIds: ["openclaw", "codex"] }),
          }),
        ]),
      }),
    );
    expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeAuthPlan: undefined }),
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
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: contextEngineCompactMock,
        maintain,
      } as never);
      contextEngineCompactMock.mockResolvedValue({
        ok: true,
        compacted: true,
        result:
          format === "SQLite marker"
            ? { sessionFile: marker, sessionId: delegatedSessionId }
            : { sessionTarget: { sessionId: delegatedSessionId } },
      } as never);
      const result = await compactEmbeddedAgentSession(wrappedCompactionArgs({ sessionTarget }));
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
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
