import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { createEmptyPluginMetadataSnapshot } from "../../plugins/plugin-metadata-empty.test-support.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import type { StreamFn } from "../runtime/index.js";
import { AuthStorage } from "../sessions/auth-storage.js";
import { getModelRegistryRuntime } from "../sessions/model-registry-runtime.js";
import { ModelRegistry } from "../sessions/model-registry.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { executeBoundedCompactionSession } from "./bounded-compaction-execution.js";
import { createEmptyPreparedModelRuntimeFixture } from "./model.fixture.test-support.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import type { prepareEmbeddedCompactionSession } from "./prepared-compaction-session.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  registerProviderStream: vi.fn(),
}));

// mock-isolation: replace transcript I/O; the bounded execution/retry owner stays real.
vi.mock("./prepared-compaction-session.js", () => ({
  prepareEmbeddedCompactionSession: mocks.prepare,
}));
// mock-isolation: supply deterministic provider registration without plugin discovery.
vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: mocks.registerProviderStream,
}));
// mock-isolation: preserve the transport while excluding diagnostic event storage.
vi.mock("./run/attempt.model-diagnostic-events.js", () => ({
  wrapStreamFnWithDiagnosticModelCallEvents: (stream: StreamFn) => stream,
}));
// mock-isolation: no user hooks or post-compaction external effects in this fixture.
vi.mock("./compaction-hooks.js", () => ({
  runCompactionHooks: vi.fn(),
  runPostCompactionSideEffects: vi.fn(),
}));
// mock-isolation: avoid global plugin discovery for the hookless fixture.
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
}));
// mock-isolation: the real session-agent and base-stream resolver run without plugin transforms.
vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderTextTransforms: () => undefined,
}));
// mock-isolation: a synthetic model has no plugin handle or plugin loader lifecycle.
vi.mock("../../plugins/provider-hook-runtime.js", () => ({
  getModelProviderRuntimePluginHandle: () => undefined,
}));
// mock-isolation: provider-specific parameter wrappers are orthogonal to base-stream ownership.
vi.mock("./extra-params.js", () => ({
  applyExtraParamsToAgent: () => ({ effectiveExtraParams: {} }),
  resolvePreparedExtraParams: () => ({}),
}));
// mock-isolation: importing the real base-stream resolver must not install a global transport host.
vi.mock("../ai-transport-runtime-host.js", () => ({}));
// mock-isolation: this synthetic model never uses the Vertex transport.
vi.mock("../anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: vi.fn(),
}));

type ExecuteOptions = Parameters<
  Awaited<ReturnType<typeof prepareEmbeddedCompactionSession>>["execute"]
>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => testing.resetSessionControllerForTest());

describe("executeBoundedCompactionSession", () => {
  it.each(["provider", "runtime"] as const)(
    "preserves the foreground watchdog and %s stream across a thinking retry",
    async (transport) => {
      const authStorage = AuthStorage.inMemory();
      const modelRegistry = ModelRegistry.inMemory(authStorage);
      const { llmRuntime } = getModelRegistryRuntime(modelRegistry);
      const providerStream = vi.fn<StreamFn>();
      mocks.registerProviderStream.mockReturnValue(
        transport === "provider" ? providerStream : undefined,
      );
      const operation = createReplyOperation({
        sessionKey: "agent:main:test",
        sessionId: "session",
        resetTriggered: false,
      });
      operation.setPhase("running");
      const foreground = operation.watchdog.attachAttempt({ assertCurrent() {} });
      const deadline = Date.now() + 60 * 60_000;
      foreground.setExecutionDeadline(deadline);
      const wait = foreground.beginWait({ kind: "runtime_owned", isCurrent: () => true });
      const execute = vi
        .fn<(options: ExecuteOptions) => Promise<unknown>>()
        .mockRejectedValueOnce(new Error("thinking level high is not supported"))
        .mockResolvedValueOnce({
          status: "completed",
          result: { summary: "Synthetic summary", firstKeptEntryId: "kept", tokensBefore: 100 },
          reportingTokensAfter: 20,
          messageCountAfter: 2,
        });
      mocks.prepare.mockImplementation(async () => ({
        effects: {},
        value: {
          hasRealConversation: true,
          beforeHookMetrics: {
            messageCountOriginal: 4,
            messageCountBefore: 4,
            tokenCountBefore: 100,
          },
        },
        execute,
      }));
      const model = makeProviderModelFixture({
        id: "synthetic-model",
        provider: "synthetic-provider",
        api: "openai-completions",
        baseUrl: "https://example.invalid",
        reasoning: true,
      });
      const fail = vi.fn((reason: string) => ({
        ok: false as const,
        compacted: false as const,
        reason,
      }));
      const agentDir = "/synthetic/agent";
      const workspaceDir = "/synthetic/workspace";
      const runtimePlan = buildAgentRuntimePlan({
        provider: model.provider,
        modelId: model.id,
        model,
        workspaceDir,
        preparedAuthPlan: {
          providerForAuth: model.provider,
          authProfileProviderForAuth: model.provider,
        },
        providerRuntimeHandle: {
          provider: model.provider,
          modelId: model.id,
          workspaceDir,
          prepared: true,
        },
      });
      // Keep the admitted fixture complete so changes to the runtime contract
      // are checked even though transcript I/O and plugin discovery are mocked.
      const runtime: PreparedCompactionRuntime = {
        params: {
          sessionId: "session",
          workspaceDir,
          sessionFile: "/synthetic/session.jsonl",
          config: {},
          skillsSnapshot: undefined,
          preparedModelRuntime: createEmptyPreparedModelRuntimeFixture({
            agentDir,
            config: {},
            metadataSnapshot: createEmptyPluginMetadataSnapshot(),
            createStores: () => ({ authStorage, modelRegistry }),
          }),
        },
        diagId: "compaction-test",
        attempt: 1,
        maxAttempts: 1,
        runId: "compaction-test",
        compactionModelCallTrace: createDiagnosticTraceContext(),
        contextConfigProvider: model.provider,
        preparedHarnessRuntime: "openclaw",
        authStorage,
        runtimeModel: model,
        apiKeyInfo: { source: "synthetic", mode: "api-key" },
        runtimeApiKey: undefined,
        resolvedRuntimeAuthPlan: runtimePlan.auth,
        hasRuntimeAuthExchange: false,
        resolvedWorkspace: workspaceDir,
        sandboxSessionKey: "agent:main:test",
        sandboxAgentId: "main",
        sandbox: null,
        effectiveCwd: workspaceDir,
        releaseSandbox: () => {},
        runtimePlan,
        runtimePlanModelContext: { workspaceDir, modelApi: model.api, model },
        effectiveTools: [],
        allowedToolNames: new Set(),
        resolvedMessageProvider: undefined,
        provider: model.provider,
        modelId: model.id,
        effectiveModel: model,
        modelRegistry,
        trigger: "manual",
        thinkLevel: "high",
        attemptedThinking: new Set(),
        agentDir,
        effectiveWorkspace: workspaceDir,
        sessionAgentId: "main",
        diagnosticCompactionRunId: "compaction-test",
        nextDiagnosticModelCallId: () => "call-test",
        contextTokenBudget: 16000,
        buildSystemPromptText: () => "Summarize the synthetic conversation.",
        fail,
      };
      const target = {
        agentId: "main",
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/synthetic/sessions/store.sqlite",
      };
      const result = await withSessionControllerOwner(operation, () =>
        executeBoundedCompactionSession(
          runtime,
          target,
          SettingsManager.inMemory(),
          () => {},
          vi.fn(),
          undefined,
          { agent: { streamFn: llmRuntime.streamSimple }, replayEnabled: false },
        ),
      );

      expect(foreground.isCurrent()).toBe(true);
      expect(operation.watchdog.snapshot().waits).toEqual([{ kind: "runtime_owned" }]);
      expect(operation.watchdog.snapshot().executionDeadlineAtMs).toBe(deadline);
      expect(foreground.progressModel("resumed after compaction")).toBe(true);
      wait.close();
      operation.complete();

      expect(result).toMatchObject({
        ok: true,
        compacted: true,
        result: { summary: "Synthetic summary", tokensBefore: 100, tokensAfter: 20 },
      });
      expect(fail).not.toHaveBeenCalled();
      expect(execute.mock.calls.map(([options]) => options.thinkingLevel)).toEqual(["high", "off"]);
      expect(execute.mock.calls.every(([options]) => typeof options.streamFn === "function")).toBe(
        true,
      );
    },
  );
});
