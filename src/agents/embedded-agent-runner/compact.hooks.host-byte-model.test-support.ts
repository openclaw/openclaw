import { expectDefined } from "@openclaw/normalization-core";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  requireActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "../harness/registry.js";
import type { AgentHarness } from "../harness/types.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "../sessions/agent-session-loop-resource-loader.test-support.js";
import { SessionManager } from "../sessions/session-manager.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { expectedNativeCompactionOptions } from "./compact.hooks.fixture.test-support.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  selectAgentHarnessMock,
  selectAgentHarnessForPreparedModelProvidersMock,
  limitHistoryTurnsMock,
  ensureAuthProfileStoreMock,
  getApiKeyForModelMock,
  attemptServerEndpointCompactionMock,
  buildAgentRuntimePlanMock,
  createAgentSessionMock,
  resolveContextEngineMock,
  maybeCompactAgentHarnessSessionMock,
  hookRunner,
} from "./compact.hooks.harness.js";
import type { CompactHooksQueuedCompaction } from "./compact.hooks.metadata.test-support.js";

export function registerCodexByteCompactionHarness() {
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
  for (const select of [selectAgentHarnessMock, selectAgentHarnessForPreparedModelProvidersMock]) {
    const fallback = expectDefined(select.getMockImplementation(), "harness selection fixture");
    select.mockImplementation((params) =>
      params.agentHarnessId === "codex" || params.agentHarnessRuntimeOverride === "codex"
        ? registeredHarness
        : fallback(params),
    );
  }
}

export function registerCodexHostByteModelTests(fixture: {
  compact: () => CompactHooksQueuedCompaction;
  wrappedArgs: (overrides?: Record<string, unknown>) => Parameters<CompactHooksQueuedCompaction>[0];
  workspaceDir: () => string;
}): void {
  describe("host byte summary model", () => {
    registerAgentSessionLoopTestLifecycle();

    it("keeps manual native compaction on the chat model with a host summary override", async () => {
      registerCodexByteCompactionHarness();
      resolveContextEngineMock.mockResolvedValue({
        info: { id: "legacy", name: "Legacy", version: "1.0.0", ownsCompaction: false },
        compact: (input: Parameters<ContextEngine["compact"]>[0]) =>
          delegateCompactionToRuntime(input),
      } as never);
      maybeCompactAgentHarnessSessionMock.mockResolvedValue({ ok: true, compacted: true });
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            compaction: {
              model: "deepseek/legacy-summary",
              transcriptByteModel: "deepseek/deepseek-flash",
              maxActiveTranscriptBytes: "20mb",
            },
          },
        },
      };
      const { resolveManualCompactionCliTarget } = await import("../session-runtime-compat.js");
      const nativeTarget = resolveManualCompactionCliTarget({
        provider: "openai",
        entry: { agentHarnessId: "codex" },
        cfg: config,
      });
      expect(nativeTarget.agentHarnessId).toBe("codex");
      const result = await fixture.compact()(
        fixture.wrappedArgs({
          ...nativeTarget,
          provider: "openai",
          model: "gpt-5.5",
          trigger: "manual",
          config,
        }),
      );
      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledOnce();
      expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openai", model: "gpt-5.5", agentHarnessId: "codex" }),
        expect.any(Object),
      );
      expect(createAgentSessionMock).not.toHaveBeenCalled();
    });

    it("does not accept a public authority field without the private host claim", async () => {
      registerCodexByteCompactionHarness();
      const params = fixture.wrappedArgs({
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: "codex",
        trigger: "budget",
        preflightRequired: true,
        preflightCompactionTrigger: "transcript_bytes",
        config: {
          agents: { defaults: { compaction: { transcriptByteModel: "deepseek/deepseek-flash" } } },
        },
      });
      const forgedAssertion = vi.fn(async () => {
        throw new Error("forged source must not be used");
      });
      const result = await delegateCompactionToRuntime({
        sessionId: params.sessionId,
        sessionKey: expectDefined(params.sessionKey, "test session key"),
        sessionTarget: params.sessionTarget,
        tokenBudget: 128_000,
        force: true,
        runtimeContext: {
          ...params,
          transcriptBytePreflightAuthority: true,
          assertTranscriptBytePreflightActive: forgedAssertion,
        },
      });
      expect(result).toMatchObject({ ok: true, compacted: true });
      expect(buildAgentRuntimePlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ harnessId: "codex" }),
      );
      expect(attemptServerEndpointCompactionMock).toHaveBeenCalledOnce();
      expect(forgedAssertion).not.toHaveBeenCalled();
    });

    it.each([
      "unlocked",
      "locked",
      "revoked",
      "replaced-writer",
      "operator-allowed",
      "operator-denied",
      "model-permission-removed",
      "old-model-only",
      "builtin-byte",
      "builtin-old-model-only",
      "builtin-manual",
      "builtin-tokens",
      "builtin-public-trigger-only",
      "builtin-locked",
      "builtin-operator-denied",
    ] as const)("gates host summary model egress for %s history", async (scenario) => {
      const locked = scenario.endsWith("locked") && scenario !== "unlocked";
      const builtin = scenario.startsWith("builtin-");
      const oldModelOnly = scenario.endsWith("old-model-only");
      const byteTrigger = scenario !== "builtin-manual" && scenario !== "builtin-tokens";
      const trustedByteTrigger = byteTrigger && scenario !== "builtin-public-trigger-only";
      const useByteModel = !locked && !oldModelOnly && trustedByteTrigger;
      const expectedModel =
        locked || (!builtin && oldModelOnly)
          ? { provider: "openai", id: "gpt-5.5" }
          : { provider: "deepseek", id: useByteModel ? "deepseek-flash" : "legacy-summary" };
      let sourceActive = true;
      let summaryAllowed = !scenario.endsWith("operator-denied");
      const operatorScenario =
        scenario.includes("operator-") || scenario === "model-permission-removed";
      const policyListeners = new Set<() => void>();
      let bindingsAtPermissionRemoval: number | undefined;
      const assertSourceActive = () => {
        if (!sourceActive) {
          throw new Error("summary source revoked");
        }
      };
      const operatorAuthority = operatorScenario
        ? createAdmittedRunOperatorAuthority({
            profileId: "summary-operator",
            scopes: ["operator.write"],
            assertCurrent: assertSourceActive,
            modelPolicy: {
              models: [{ provider: "openai", model: "gpt-5.5" }],
              allows: (model) => model.provider === "openai" || summaryAllowed,
            },
            onModelPolicyChanged: (listener) => {
              policyListeners.add(listener);
              return () => policyListeners.delete(listener);
            },
          })
        : undefined;
      registerCodexByteCompactionHarness();
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            compaction: {
              model: "deepseek/legacy-summary",
              ...(!oldModelOnly ? { transcriptByteModel: "deepseek/deepseek-flash" } : {}),
              ...(!builtin ? { provider: "synthetic-provider" } : {}),
              maxActiveTranscriptBytes: "20mb",
            },
          },
        },
      };
      ensureAuthProfileStoreMock.mockReturnValue({
        version: 1,
        profiles: {
          "openai:source": { type: "api_key", provider: "openai", key: "synthetic-source-key" },
        },
      });
      getApiKeyForModelMock.mockImplementation(async (auth) => ({
        apiKey:
          auth?.profileId === "openai:source" ? "synthetic-source-key" : "synthetic-summary-key",
        mode: "api-key",
        source: "test harness",
        profileId: auth?.profileId,
      }));
      const params = fixture.wrappedArgs({
        config,
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessId: builtin ? "openclaw" : "codex",
        modelSelectionLocked: locked,
        authProfileId: "openai:source",
        authProfileIdSource: "user",
        runtimeAuthPlan: {
          providerForAuth: "openai",
          modelId: "gpt-5.5",
          selectedAuthMode: "api-key",
          forwardedAuthProfileId: "openai:source",
          forwardedAuthProfileSource: "user",
          modelRoute: {
            provider: "openai",
            modelId: "gpt-5.5",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            authRequirement: "api-key",
            requestTransportOverrides: "none",
            runtimePolicy: { compatibleIds: [builtin ? "openclaw" : "codex"] },
          },
        },
        trigger: scenario === "builtin-manual" ? "manual" : "budget",
        forcePreflight: true,
        preflightRequired: true,
        preflightCompactionTrigger: byteTrigger ? "transcript_bytes" : "tokens",
      });
      const target = {
        agentId: expectDefined(params.sessionTarget?.agentId, "test agent id"),
        sessionId: params.sessionId,
        sessionKey: expectDefined(params.sessionKey, "test session key"),
        storePath: expectDefined(params.sessionTarget?.storePath, "test store path"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: params.sessionId,
        updatedAt: 1,
        agentHarnessId: builtin ? "openclaw" : "codex",
        modelSelectionLocked: locked,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
      const [{ guardSessionManager }, { resolveEmbeddedAgentStream }, { createAgentSession }] =
        await Promise.all([
          import("../session-tool-result-guard-wrapper.js"),
          import("./stream-resolution.js"),
          import("../sessions/sdk.js"),
        ]);
      const sessionManager = SessionManager.inMemory(fixture.workspaceDir());
      for (const content of ["Review the checklist.", "Compare options.", "Keep the notes."]) {
        await sessionManager.appendMessageAsync({ role: "user", content, timestamp: 1 });
      }
      vi.mocked(guardSessionManager).mockReturnValue(sessionManager);
      limitHistoryTurnsMock.mockImplementation((messages) => messages);
      const stream = vi.fn<StreamFn>((model) => {
        const events = createAssistantMessageEventStream();
        queueMicrotask(() => {
          events.push({
            type: "done",
            reason: "stop",
            message: createAssistant(model, [
              { type: "text", text: "Kept the checklist, options and notes." },
            ]),
          });
          events.end();
        });
        return events;
      });
      vi.mocked(resolveEmbeddedAgentStream).mockReturnValue({
        streamFn: stream,
        strategy: "session-custom",
      });
      vi.mocked(createAgentSession).mockImplementation(async ({ model }) => {
        if (!model) {
          throw new Error("Expected prepared compaction model");
        }
        return createTestSession({
          model: { ...testModel, ...model },
          sessionManager,
          settingsManager: SettingsManager.inMemory({
            compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
            retry: { enabled: false },
          }),
          resourceLoader: createResourceLoader(),
        });
      });
      const compactEngine = vi.fn<ContextEngine["compact"]>((input) =>
        delegateCompactionToRuntime(input),
      );
      resolveContextEngineMock.mockResolvedValue({
        info: { id: "legacy", name: "Legacy", version: "1.0.0" },
        compact: compactEngine,
      } as never);
      maybeCompactAgentHarnessSessionMock.mockResolvedValue({ ok: true, compacted: true });
      if (
        scenario === "revoked" ||
        scenario === "replaced-writer" ||
        scenario === "model-permission-removed"
      ) {
        hookRunner.hasHooks.mockImplementation((name) => name === "before_compaction");
        hookRunner.runBeforeCompaction.mockImplementationOnce(async () => {
          if (scenario === "revoked") {
            sourceActive = false;
          } else if (scenario === "model-permission-removed") {
            bindingsAtPermissionRemoval = policyListeners.size;
            summaryAllowed = false;
            for (const listener of policyListeners) {
              listener();
            }
          } else {
            await patchSessionEntryCore(target, (entry) => ({
              ...entry,
              activeWriterRunId: "replacement-writer",
            }));
          }
        });
      }

      const result = await fixture
        .compact()(params, {
          ...(trustedByteTrigger ? { transcriptBytePreflight: true as const } : {}),
          ...(!builtin ? { transcriptBytePreflightHarness: "codex" as const } : {}),
          assertActive: assertSourceActive,
          sourceAuthority: { assertActive: assertSourceActive, operatorAuthority },
        })
        .catch((error: unknown) => {
          if (
            ![
              "revoked",
              "replaced-writer",
              "operator-denied",
              "builtin-operator-denied",
              "model-permission-removed",
            ].includes(scenario)
          ) {
            throw error;
          }
          return {
            ok: false,
            compacted: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        });

      if (
        [
          "revoked",
          "replaced-writer",
          "operator-denied",
          "builtin-operator-denied",
          "model-permission-removed",
        ].includes(scenario)
      ) {
        if (scenario === "model-permission-removed") {
          expect(bindingsAtPermissionRemoval).toBe(1);
        }
        expect(result).toMatchObject({ ok: false, compacted: false });
        expect(result.reason).toContain(
          scenario === "revoked"
            ? "summary source revoked"
            : scenario === "replaced-writer"
              ? "writer"
              : "operator role cannot use this model",
        );
        expect(stream).not.toHaveBeenCalled();
        expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
        expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
        return;
      }
      expect(result, result.reason).toMatchObject({ ok: true, compacted: true });
      expect(stream).toHaveBeenCalledOnce();
      expect(vi.mocked(resolveEmbeddedAgentStream).mock.calls.at(-1)?.[0].resolvedApiKey).toBe(
        expectedModel.provider === "openai" ? "synthetic-source-key" : "synthetic-summary-key",
      );
      expect(stream.mock.calls[0]?.[0]).toMatchObject(expectedModel);
      expect(
        sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
      ).toMatchObject({ summary: "Kept the checklist, options and notes." });
      if (builtin) {
        expect(maybeCompactAgentHarnessSessionMock).not.toHaveBeenCalled();
      } else {
        expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledOnce();
        expect(maybeCompactAgentHarnessSessionMock).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: "openai",
            model: "gpt-5.5",
            agentHarnessId: "codex",
            authProfileId: "openai:source",
          }),
          {
            ...expectedNativeCompactionOptions("after_context_engine"),
            sourceAuthority: { assertActive: expect.any(Function), operatorAuthority },
          },
        );
      }
      expect(loadSessionEntryReadOnly(target)).toMatchObject({
        agentHarnessId: builtin ? "openclaw" : "codex",
        modelSelectionLocked: locked,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      });
      expect(config.agents?.defaults?.compaction?.model).toBe("deepseek/legacy-summary");
    });
  });
}
