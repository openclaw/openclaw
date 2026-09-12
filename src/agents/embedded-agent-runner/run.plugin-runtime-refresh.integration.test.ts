import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentHarness } from "../harness/types.js";
import { captureAgentPluginRuntimeRefresh } from "../plugin-runtime-refresh.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import type { PreparedModelRuntimePluginGeneration } from "../prepared-model-runtime.types.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
afterEach(async () => {
  await state?.cleanup();
});

describe("plugin runtime refresh admission", () => {
  it("reacquires generations while preserving run authority, committed work, and one terminal", async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const { getAgentRunContext } = await import("../../infra/agent-run-registry.js");
    state = await createOpenClawTestState({ label: "plugin-runtime-refresh" });
    const runParams = createOverflowRunParams(state);
    const originalPrompt = "edit and reload twice";
    const originalMessage = { role: "user" as const, content: originalPrompt, timestamp: 1 };
    const onUserMessagePersisted = vi.fn();
    const onAgentEvent = vi.fn();
    const base = await mockedAcquireAgentRunPreparedModelRuntime({
      agentId: "main",
      agentDir: state.agentDir(),
      config: {},
      workspaceDir: state.workspaceDir,
    });
    // Distinct registries prove that an old ambient owner cannot supply the next generation.
    // oxlint-disable-next-line no-map-spread -- Every generation needs an independent registry, not mutations of its predecessor.
    const snapshots = ["first", "next", "final"].map((policyHash) => ({
      ...base.snapshot,
      metadataSnapshot: {
        ...base.snapshot.metadataSnapshot,
        policyHash,
        workspaceDir: state.workspaceDir,
      },
      pluginRegistry: {
        ...base.snapshot.pluginRegistry!,
        tools: [...(base.snapshot.pluginRegistry?.tools ?? [])],
      },
    }));
    const first = snapshots[0]!;
    const generation: PreparedModelRuntimePluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: first.metadataSnapshot,
      pluginRegistry: first.pluginRegistry,
    };
    const releases = snapshots.map(() => vi.fn(async () => {}));
    const caller = { isWebchatConnect: () => false, invokeWithSessionNodeAuthority: vi.fn() };
    mockedAcquireAgentRunPreparedModelRuntime.mockClear();
    let admittedOwner: unknown;
    const staleOwners: ReturnType<typeof captureAgentPluginRuntimeRefresh>[] = [];
    for (const [index, snapshot] of snapshots.entries()) {
      mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(async () => {
        if (index > 0) {
          expect(releases[index - 1]).toHaveBeenCalledOnce();
          expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
          expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBeUndefined();
          expect(getPluginRuntimeGatewayRequestScope()?.invokeWithSessionNodeAuthority).toBe(
            caller.invokeWithSessionNodeAuthority,
          );
        }
        return { ...base, snapshot, [Symbol.asyncDispose]: releases[index]! };
      });
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
        // This fixture replaces attempt execution; the real embedded consumer is covered by the agent loop tests.
        params.registerPluginRuntimeRefreshConsumer?.(() => true);
        if (index === 0) {
          admittedOwner = getAgentRunContext(params.runId)?.delegatedAuthority;
          expect(admittedOwner).toBeDefined();
          expect(params.prompt).toBe(originalPrompt);
          params.onUserMessagePersisted?.(originalMessage);
        } else {
          expect(getAgentRunContext(params.runId)?.delegatedAuthority).toBe(admittedOwner);
          expect(params.prompt).toContain("Continue the current task from the transcript");
          expect(params.prompt).not.toContain(originalPrompt);
          expect(params.skipPreparedUserTurnMessage).toBe(true);
          expect(params.suppressNextUserMessagePersistence).toBe(true);
          for (const stale of staleOwners) {
            expect(() => stale.assertCurrent()).toThrow("Plugin runtime changed");
          }
        }
        expect(params.sessionId).toBe("test-session");
        expect(getPluginRuntimeGenerationRegistry()).toBe(snapshot.pluginRegistry);
        params.hostCapabilities?.assertActive();
        if (index < 2) {
          const owner = captureAgentPluginRuntimeRefresh();
          staleOwners.push(owner);
          expect(owner.request()).toBe(true);
          return makeAttemptResult({
            assistantTexts: [],
            sessionIdUsed: params.sessionId,
            toolMetas: [
              { toolName: " plugins ", isError: false },
              { toolName: "failed", isError: true },
              { toolName: "unknown" },
              ...(index === 1 ? [{ toolName: "read", isError: false }] : []),
            ],
            successfulNestedToolNames: index === 0 ? ["zeta", "alpha", "plugins"] : ["beta"],
          });
        }
        return makeAttemptResult({
          assistantTexts: ["new behavior verified"],
          sessionIdUsed: params.sessionId,
          toolMetas: [{ toolName: "final_check", isError: false }],
        });
      });
    }
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "new behavior verified" }]);
    try {
      const result = await withPluginRuntimeGatewayRequestScope(caller, () =>
        withPreparedModelRuntimePluginGenerationScope(
          generation,
          () =>
            withPluginRuntimeGenerationScope(first, () =>
              runEmbeddedAgent({
                ...runParams,
                prompt: originalPrompt,
                onUserMessagePersisted,
                onAgentEvent,
                agentHarnessId: "openclaw",
                provider: "fixture-provider",
                model: "fixture-model",
                sessionKey: undefined,
              }),
            ),
          () => first as NonNullable<ReturnType<typeof getPreparedModelRuntimeBorrowedSnapshot>>,
        ),
      );
      expect(result.payloads).toEqual([{ text: "new behavior verified" }]);
      expect(result.meta.agentMeta?.terminalReceipt).toMatchObject({
        runId: runParams.runId,
        sessionId: "test-session",
        successfulToolNames: ["plugins", "alpha", "zeta", "read", "beta", "final_check"],
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
      expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledTimes(3);
      expect(onUserMessagePersisted).toHaveBeenCalledExactlyOnceWith(originalMessage);
      expect(
        onAgentEvent.mock.calls.filter(
          ([event]) => event.stream === "lifecycle" && event.data.phase === "end",
        ),
      ).toHaveLength(1);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
      }
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["separate operator turn"] }),
      );
      const next = await runEmbeddedAgent({ ...runParams, prompt: "new task" });
      expect(next.meta.agentMeta?.terminalReceipt?.successfulToolNames).toEqual([]);
    } finally {
      mockedAcquireAgentRunPreparedModelRuntime.mockReset();
      mockedRunEmbeddedAttempt.mockReset();
    }
  });
  it("does not readmit completed work after a provider-shaped handoff failure", async () => {
    const { runEmbeddedAgent } = await loadRunOverflowCompactionHarness();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "plugin-refresh-failure" });
    const runParams = createOverflowRunParams(state);
    const onAgentEvent = vi.fn();
    const completedEffect = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementation(async (params) => {
      params.registerPluginRuntimeRefreshConsumer?.(() => true);
      expect(captureAgentPluginRuntimeRefresh().request()).toBe(true);
      completedEffect();
      return makeAttemptResult({
        assistantTexts: [],
        sessionIdUsed: params.sessionId,
        toolMetas: [{ toolName: "plugins", replaySafe: false }],
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new AggregateError(
            [Object.assign(new Error("service unavailable"), { status: 503 })],
            "Plugin runtime changed, but runtime continuation failed. Do not repeat completed actions.",
          ),
        },
      });
    });
    try {
      const result = await runEmbeddedAgent({
        ...runParams,
        prompt: "reload and verify",
        agentHarnessId: "openclaw",
        provider: "fixture-provider",
        model: "fixture-model",
        sessionKey: undefined,
        onAgentEvent,
      });
      expect(completedEffect).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedAcquireAgentRunPreparedModelRuntime).toHaveBeenCalledOnce();
      expect(result.meta.error).toBeDefined();
      expect(
        onAgentEvent.mock.calls.filter(
          ([event]) => event.stream === "lifecycle" && event.data.phase === "error",
        ),
      ).toHaveLength(1);
    } finally {
      mockedRunEmbeddedAttempt.mockReset();
    }
  });
  it.each([false, true])(
    "uses only producer-owned settled finalization context (present: %s)",
    async (hasContext) => {
      const { runEmbeddedAgent, registerPreparedAgentHarness } =
        await loadRunOverflowCompactionHarness();
      const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      state = await createOpenClawTestState({ label: "plugin-refresh-stale-finalization" });
      const assistant = buildEmbeddedRunnerAssistant({
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "committed-write",
            name: "write",
            arguments: { path: "plugin.ts", content: "changed" },
          },
        ],
      });
      const messages: EmbeddedRunAttemptResult["messagesSnapshot"] = [
        assistant,
        {
          role: "toolResult",
          toolCallId: "committed-write",
          toolName: "write",
          content: [{ type: "text", text: "plugin source written" }],
          isError: false,
          timestamp: Date.now(),
        },
      ];
      const handoffError = new Error(
        hasContext
          ? "Attempt ended without an answer."
          : "Plugin runtime changed, but runtime continuation failed. Do not repeat completed actions.",
      );
      const finalizedContext = { source: "openclaw-transcript" as const, messages };
      const finalizer = vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>(
        async ({ settledAttempt }) => {
          expect(settledAttempt.settledTurnFinalizationContext).toEqual(finalizedContext);
          return {
            assistant: buildEmbeddedRunnerAssistant({
              content: [{ type: "text", text: "Recovered summary" }],
            }),
          };
        },
      );
      const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (params) => {
        if (!hasContext) {
          params.registerPluginRuntimeRefreshConsumer?.(() => true);
          expect(captureAgentPluginRuntimeRefresh().request()).toBe(true);
        }
        return makeAttemptResult({
          terminal: { kind: "failed", source: "prompt", error: handoffError },
          assistantTexts: [],
          currentAttemptAssistant: undefined,
          currentAttemptCompletedAssistant: undefined,
          messagesSnapshot: messages,
          toolMetas: [{ toolName: "write", toolCallId: "committed-write", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          settledTurnFinalizationContext: hasContext ? finalizedContext : undefined,
        });
      });
      registerPreparedAgentHarness({
        id: "handoff-fixture",
        label: "Handoff fixture",
        supports: () => ({ supported: true }),
        runAttempt,
        finalizeSettledTurn: finalizer,
      });
      mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
        assistantTexts.map((text) => ({ text })),
      );
      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "fixture-provider",
        model: "fixture-model",
        agentHarnessId: "handoff-fixture",
        config: {
          models: {
            providers: {
              "fixture-provider": {
                baseUrl: "http://127.0.0.1:1/v1",
                api: "openai-responses",
                apiKey: "synthetic-test-key",
                models: [
                  {
                    id: "fixture-model",
                    name: "Fixture model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
        sessionKey: undefined,
      });
      expect(runAttempt).toHaveBeenCalledOnce();
      if (hasContext) {
        expect(finalizer).toHaveBeenCalledOnce();
        expect(result.meta.error).toBeUndefined();
        expect(result.payloads).toEqual([{ text: "Recovered summary" }]);
      } else {
        expect(finalizer).not.toHaveBeenCalled();
        expect(result.meta.error?.message).toContain(handoffError.message);
        expect(result.payloads).not.toContainEqual({ text: "Recovered summary" });
      }
    },
  );
});
