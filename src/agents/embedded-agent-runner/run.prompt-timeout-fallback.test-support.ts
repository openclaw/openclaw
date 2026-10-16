// Full-entry coverage for prompt timeout continuation and model fallback ownership.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../../gateway/subagent-completion-tool-handoff.js";
import type { EmbeddedRunAttemptParamsV2 } from "../../plugin-sdk/agent-harness-runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { applyDelegationCapability } from "../delegation-capability.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import type { AnyAgentTool } from "../tools/common.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  MockedFailoverError,
  mockedBuildEmbeddedRunPayloads,
  mockedClassifyFailoverReason,
  mockedGetApiKeyForModel,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.prompt-timeout-fallback" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each([
    { reason: "timeout", sourceTool: "subagent_announce", harness: "openclaw" },
    { reason: "timeout", sourceTool: "subagent_settle", harness: "codex" },
    { reason: "overloaded", sourceTool: "subagent_settle", harness: "openclaw" },
    { reason: "server_error", sourceTool: "subagent_settle", harness: "openclaw" },
  ] as const)(
    "preserves delegation after a same-model $reason retry of $sourceTool under $harness",
    async ({ reason, sourceTool, harness }) => {
      mockedClassifyFailoverReason.mockReturnValue(reason);
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: [],
            terminal: {
              kind: "failed",
              source: "prompt",
              error: new Error(
                reason === "timeout"
                  ? "LLM request timed out."
                  : reason === "server_error"
                    ? "HTTP 520: controlled provider server error"
                    : "overloaded",
              ),
            },
          }),
        )
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["Completion received."] }));

      const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessRuntimeOverride: harness,
        runId: "run-completion-transient-retry",
        inputProvenance: { kind: "inter_session", sourceTool },
        config,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      for (const [attempt] of mockedRunEmbeddedAttempt.mock.calls) {
        expect(attempt).toMatchObject({
          provider: "openai",
          modelId: "gpt-5.4",
          fallbackActive: false,
          fallbackReason: null,
          delegationCapability: "full",
        });
        // The shared gate consumes this exact dispatched capability; it cannot
        // restore a tool removed by ordinary authorization before this stage.
        const authorizedTools = ["sessions_send", "sessions_spawn"].map(
          (name) => ({ name }) as AnyAgentTool,
        );
        expect(applyDelegationCapability(authorizedTools, attempt.delegationCapability)).toEqual(
          authorizedTools,
        );
      }
    },
  );

  it.each([
    { harness: "openclaw", toolsAllow: undefined },
    { harness: "codex", toolsAllow: undefined },
    { harness: "codex", toolsAllow: ["*"] },
  ] as const)(
    "retains host delegation without native collaboration under $harness (tools: $toolsAllow)",
    async ({ harness, toolsAllow }) => {
      const run = createOverflowRunParams(state);
      if (harness === "codex") {
        const { getRegisteredAgentHarness, registerAgentHarness } =
          await import("../harness/registry.js");
        const native = getRegisteredAgentHarness(harness);
        if (!native) {
          throw new Error("Missing fixture harness");
        }
        // Match extensions/codex/harness.ts while replacing only native model I/O.
        registerAgentHarness({ ...native.harness, conversationToolPolicySupport: "exact" });
      }
      const config = {
        session: { store: state.statePath("agents", "main", "sessions", "sessions.json") },
      };
      // The shared harness resets modules before loading the runner. Use its
      // current session/config owners rather than a pre-reset static accessor.
      const { replaceSessionEntry } = await import("../../config/sessions/session-accessor.js");
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      const sourceSessionKey = "agent:main:subagent:finished-child";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: sourceSessionKey },
        {
          sessionId: "finished-child-id",
          updatedAt: 1,
          spawnedBy: run.sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: [],
          inheritedToolDeny: [],
        },
      );
      const registration = {
        sourceSessionKey,
        targetSessionKey: run.sessionKey,
        targetSessionId: run.sessionId,
        idempotencyKey: run.runId,
        settleBatch: { sourceSessionKeys: [sourceSessionKey], isCurrent: () => true },
      };
      const trustedInternalHandoff = consumeSubagentCompletionToolHandoff({
        ...registration,
        handoffId: registerSubagentCompletionToolHandoff(registration),
        sourceTool: "subagent_settle",
        provider: "openai",
        model: "gpt-5.4",
      });
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
        expect(attempt.fallbackActive).toBe(true);
        if (harness === "codex") {
          const codex = await loadBundledPluginFacade<{
            resolveCodexPromptSnapshotAppServerOptions: () => unknown;
            buildCodexHarnessPromptSnapshot: (params: {
              attempt: EmbeddedRunAttemptParamsV2;
              cwd: string;
              threadId: string;
              dynamicTools: Array<{
                type: "function";
                name: string;
                description: string;
                inputSchema: { type: string };
              }>;
              appServer: unknown;
            }) => Promise<{
              developerInstructions: string;
              threadStartParams: { config?: Record<string, unknown>; dynamicTools?: unknown };
              threadResumeParams: { config?: Record<string, unknown> };
            }>;
          }>({ pluginId: "codex", artifactBasename: "test-api.js" });
          const hostCapabilities = attempt.hostCapabilities;
          if (!hostCapabilities) {
            throw new Error("Native attempt lacks its admitted host capability");
          }
          const dynamicTools = ["sessions_send", "sessions_spawn"].map((name) => ({
            type: "function" as const,
            name,
            description: name,
            inputSchema: { type: "object" },
          }));
          const render = (delegationCapability: typeof attempt.delegationCapability) =>
            codex.buildCodexHarnessPromptSnapshot({
              attempt: { ...attempt, delegationCapability, hostCapabilities },
              cwd: state.workspaceDir,
              threadId: "settle-thread",
              dynamicTools,
              appServer: codex.resolveCodexPromptSnapshotAppServerOptions(),
            });
          const restricted = await render(attempt.delegationCapability);
          for (const request of [restricted.threadStartParams, restricted.threadResumeParams]) {
            expect(request.config).toMatchObject({
              "agents.enabled": false,
              "features.multi_agent": false,
              "features.multi_agent_v2": false,
            });
          }
          expect(restricted.threadStartParams.dynamicTools).toEqual(dynamicTools);
          expect(restricted.developerInstructions).not.toContain("spawn_agent");
          // A permissive ordinary turn still has native delegation: no other gate masks this proof.
          const ordinary = await render("full");
          expect(ordinary.threadStartParams.config).not.toHaveProperty("agents.enabled", false);
          expect(ordinary.developerInstructions).toContain("spawn_agent");
        }
        expect(attempt.delegationCapability).toBe("host_only");
        return makeAttemptResult({ assistantTexts: ["Continue the authorized work."] });
      });
      await runEmbeddedAgent({
        ...run,
        config,
        toolsAllow: toolsAllow ? [...toolsAllow] : undefined,
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessRuntimeOverride: harness,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle", sourceSessionKey },
        trustedInternalHandoff,
        modelRoutingProvenance: {
          stage: "fallback",
          requestedProvider: "openai",
          requestedModel: "gpt-4.1",
          fallbackReason: "rate_limit",
        },
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      requestedProvider: "anthropic",
      requestedModel: "claude-opus-4-6",
      fallbackReason: "timeout",
    },
    { requestedProvider: "anthropic", requestedModel: "gpt-5.4", fallbackReason: "overloaded" },
    { requestedProvider: "openai", requestedModel: "gpt-5.4", fallbackReason: undefined },
  ] as const)(
    "keeps an actual $requestedProvider/$requestedModel fallback completion report-only",
    async ({ requestedProvider, requestedModel, fallbackReason }) => {
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({ assistantTexts: ["Completion received."] }),
      );
      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.4",
        runId: "run-completion-model-fallback",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        modelRoutingProvenance: {
          stage: "fallback",
          requestedProvider,
          requestedModel,
          fallbackReason,
        },
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      const attempt = mockedRunEmbeddedAttempt.mock.calls[0]?.[0];
      expect(attempt).toMatchObject({
        fallbackActive: true,
        fallbackReason: fallbackReason ?? null,
        delegationCapability: "report_only",
      });
      const authorizedTools = ["sessions_send", "sessions_spawn", "sessions_history"].map(
        (name) => ({ name }) as AnyAgentTool,
      );
      expect(applyDelegationCapability(authorizedTools, attempt?.delegationCapability)).toEqual([
        authorizedTools[2],
      ]);
    },
  );

  it.each([{ disableTools: true }, { toolsAllow: ["message"] }])(
    "retains completion restrictions after retry: %j",
    async (restriction) => {
      mockedClassifyFailoverReason.mockReturnValue("timeout");
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: [],
            terminal: {
              kind: "failed",
              source: "prompt",
              error: new Error("LLM request timed out."),
            },
          }),
        )
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["Completion received."] }));
      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessRuntimeOverride: "openclaw",
        runId: "run-restricted-completion-retry",
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        ...restriction,
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      for (const [attempt] of mockedRunEmbeddedAttempt.mock.calls) {
        expect(attempt).toMatchObject({
          fallbackActive: false,
          delegationCapability: "report_only",
        });
      }
    },
  );

  it("throws FailoverError for persistent replay-safe prompt timeouts after transient retries", async () => {
    // The transient retry owner continues the same model first; a timeout that
    // persists past the retry budget hands off to the configured fallback.
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        terminal: {
          kind: "failed",
          source: "prompt",
          error: new Error("LLM request timed out."),
        },
      }),
    );

    const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(config);
    const promise = runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-prompt-timeout-fallback",
      config,
    });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    // Initial attempt plus the full same-model transient retry budget.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(9);
  });

  it.each(["openclaw", "codex"] as const)(
    "recovers an idle timeout after a settled write under the %s harness without replaying the prompt",
    async (harness) => {
      const toolUseAssistant = {
        role: "assistant" as const,
        stopReason: "toolUse" as const,
        provider: "openai",
        model: "gpt-5.4",
        content: [
          {
            type: "toolCall",
            id: "tool_write",
            name: "write",
            arguments: { path: "note.txt", content: "done" },
          },
        ],
      };
      const abortedAssistant = {
        role: "assistant" as const,
        stopReason: "aborted" as const,
        provider: "openai",
        model: "gpt-5.4",
        content: [],
      };
      const finalAssistant = {
        role: "assistant" as const,
        stopReason: "stop" as const,
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "The note was written once and verified." }],
      };
      mockedClassifyFailoverReason.mockReturnValue("timeout");
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: [],
            terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
            toolMetas: [{ toolCallId: "tool_write", toolName: "write", replaySafe: false }],
            itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
            messagesSnapshot: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Write note.txt, then read it to verify its contents." },
                ],
              },
              toolUseAssistant,
              {
                role: "toolResult",
                toolCallId: "tool_write",
                toolName: "write",
                isError: false,
              },
              abortedAssistant,
            ] as never,
            lastAssistant: abortedAssistant as never,
            currentAttemptAssistant: abortedAssistant as never,
            currentAttemptReplayMetadata: {
              hadPotentialSideEffects: true,
              replaySafe: false,
            },
          }),
        )
        .mockResolvedValueOnce(
          makeAttemptResult({
            assistantTexts: ["The note was written once and verified."],
            lastAssistant: finalAssistant as never,
            currentAttemptAssistant: finalAssistant as never,
            currentAttemptCompletedAssistant: finalAssistant as never,
          }),
        );
      mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
        assistantTexts.map((text) => ({ text })),
      );

      const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      const result = await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        provider: "openai",
        model: "gpt-5.4",
        agentHarnessRuntimeOverride: harness,
        prompt: "Write note.txt, then read it to verify its contents.",
        runId: "run-post-tool-idle-continuation",
        config,
      });

      expect(result.payloads).toEqual([{ text: "The note was written once and verified." }]);
      expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      const continuation = mockedRunEmbeddedAttempt.mock.calls[1]?.[0];
      expect(continuation?.skipPreparedUserTurnMessage).toBe(true);
      if (harness === "openclaw") {
        expect(continuation?.prompt).toContain(
          "Continue the current task from the existing transcript",
        );
        expect(continuation?.prompt).toContain(
          "Do not restart the task or repeat completed actions.",
        );
        expect(continuation?.disableTools).not.toBe(true);
        expect(continuation?.operation).not.toBe("settled-tool-finalization");
      } else {
        expect(continuation).toMatchObject({
          operation: "settled-tool-finalization",
          disableTools: true,
        });
      }
      expect(mockedGetApiKeyForModel).toHaveBeenCalledTimes(1);
    },
  );

  it("reports the idle timeout when settled-write finalization produces no answer", async () => {
    const toolUseAssistant = {
      role: "assistant" as const,
      stopReason: "toolUse" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [
        {
          type: "toolCall",
          id: "tool_write",
          name: "write",
          arguments: { path: "note.txt", content: "done" },
        },
      ],
    };
    const abortedAssistant = {
      role: "assistant" as const,
      stopReason: "aborted" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [],
    };
    const emptyAssistant = {
      role: "assistant" as const,
      stopReason: "stop" as const,
      provider: "openai",
      model: "gpt-5.4",
      content: [],
    };
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          terminal: { kind: "timeout", phase: "prompt", source: "idle" },
          toolMetas: [{ toolName: "write", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          messagesSnapshot: [
            { role: "user", content: [{ type: "text", text: "Write note.txt" }] },
            toolUseAssistant,
            {
              role: "toolResult",
              toolCallId: "tool_write",
              toolName: "write",
              isError: false,
            },
            abortedAssistant,
          ] as never,
          lastAssistant: abortedAssistant as never,
          currentAttemptAssistant: abortedAssistant as never,
          currentAttemptReplayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
      )
      .mockResolvedValue(
        makeAttemptResult({
          assistantTexts: [],
          lastAssistant: emptyAssistant as never,
          currentAttemptAssistant: emptyAssistant as never,
          currentAttemptCompletedAssistant: emptyAssistant as never,
        }),
      );

    const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(config);
    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-post-tool-idle-finalization-empty",
      config,
    });

    // Initial attempt plus both tool-free finalization attempts; no replay, no fallback model.
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.executionTrace?.fallbackUsed).not.toBe(true);
    expect(result.meta.error).toMatchObject({ kind: "incomplete_turn" });
    expect(result.payloads).toEqual([
      { text: expect.stringContaining("model idle timeout"), isError: true },
    ]);
    expect(JSON.stringify(result.payloads)).not.toContain("no final summary was produced");
  });
});
