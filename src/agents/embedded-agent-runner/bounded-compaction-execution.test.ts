import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamFn } from "../runtime/index.js";
import type { SettingsManager } from "../sessions/settings-manager.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { executeBoundedCompactionSession } from "./bounded-compaction-execution.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import type { prepareEmbeddedCompactionSession } from "./prepared-compaction-session.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  registerProviderStream: vi.fn(),
  registryRuntime: vi.fn(),
}));

// mock-isolation: replace transcript I/O; the bounded execution/retry owner stays real.
vi.mock("./prepared-compaction-session.js", () => ({
  prepareEmbeddedCompactionSession: mocks.prepare,
}));
// mock-isolation: supply deterministic provider registration without plugin discovery.
vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: mocks.registerProviderStream,
}));
// mock-isolation: supply an admitted registry runtime without building a full agent.
vi.mock("../sessions/model-registry-runtime.js", () => ({
  getModelRegistryRuntime: mocks.registryRuntime,
}));
// mock-isolation: no active host controller or watchdog is needed for this retry.
vi.mock("../../sessions/session-controller.lifecycle.js", () => ({
  getCurrentSessionControllerOwner: () => undefined,
}));
// mock-isolation: the fixture has no controller; do not load controller storage.
vi.mock("../../sessions/session-controller.state.js", () => ({
  assertSessionControllerOperation: vi.fn(),
}));
// mock-isolation: diagnostic persistence is outside the transport ownership contract.
vi.mock("../../logging/diagnostic-run-activity.js", () => ({
  createDiagnosticEmbeddedRunOwner: () => ({ generation: 1 }),
  markDiagnosticEmbeddedRunStarted: vi.fn(),
  closeDiagnosticEmbeddedRunOwner: vi.fn(),
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

describe("executeBoundedCompactionSession", () => {
  it.each(["provider", "runtime"] as const)(
    "retains a lifecycle-owned %s stream when retrying unsupported thinking",
    async (transport) => {
      const apiRegistry = createApiRegistry();
      const llmRuntime = createLlmRuntime(apiRegistry);
      const providerStream = vi.fn<StreamFn>();
      mocks.registryRuntime.mockReturnValue({ apiRegistry, llmRuntime });
      mocks.registerProviderStream.mockReturnValue(
        transport === "provider" ? providerStream : undefined,
      );
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
      // Admission, tools, and transcript storage are replaced above; only the
      // already-prepared facts consumed by the real execution owner are needed.
      const runtime = {
        params: { sessionId: "session", config: {} },
        provider: model.provider,
        modelId: model.id,
        effectiveModel: model,
        modelRegistry: {},
        trigger: "manual",
        thinkLevel: "high",
        attemptedThinking: new Set(),
        agentDir: "/synthetic/agent",
        effectiveWorkspace: "/synthetic/workspace",
        sessionAgentId: "main",
        diagnosticCompactionRunId: "compaction-test",
        nextDiagnosticModelCallId: () => "call-test",
        contextTokenBudget: 16000,
        buildSystemPromptText: () => "Summarize the synthetic conversation.",
        fail,
      } as PreparedCompactionRuntime;
      const target = {
        agentId: "main",
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/synthetic/sessions/store.sqlite",
      };
      const result = await executeBoundedCompactionSession(
        runtime,
        target,
        {} as SettingsManager,
        () => {},
        vi.fn(),
        undefined,
        { agent: { streamFn: llmRuntime.streamSimple }, replayEnabled: false },
      );

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
