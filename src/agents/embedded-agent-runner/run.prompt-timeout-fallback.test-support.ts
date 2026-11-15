import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  consumeSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "../../gateway/subagent-completion-tool-handoff.js";
import type { EmbeddedRunAttemptParamsV2 } from "../../plugin-sdk/agent-harness-runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { applyDelegationCapability } from "../delegation-capability.js";
import { buildEmbeddedRunnerAssistant } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
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
  useOpenAIPlatformAuthFixture,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
const model = { provider: "openai", model: "gpt-5.4" };

function runPrompt(runId: string, overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]> = {}) {
  return runEmbeddedAgent({
    ...createOverflowRunParams(state),
    ...model,
    runId,
    ...overrides,
  });
}

async function fallbackConfig() {
  const config = createModelFallbackConfig("openai/gpt-5.4", ["anthropic/claude-opus-4-6"]);
  const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
  setRuntimeConfigSnapshot(config);
  return config;
}

function promptFailure(message = "LLM request timed out.") {
  return makeAttemptResult({
    assistantTexts: [],
    terminal: { kind: "failed", source: "prompt", error: new Error(message) },
  });
}

function completedAttempt(text?: string) {
  const assistant = buildEmbeddedRunnerAssistant({
    ...model,
    content: text ? [{ type: "text", text }] : [],
  });
  return makeAttemptResult({
    assistantTexts: text ? [text] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
  });
}
function settledWriteTimeout(prompt: string, aborted = false) {
  const toolUseAssistant = buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    ...model,
    content: [
      {
        type: "toolCall",
        id: "tool_write",
        name: "write",
        arguments: { path: "note.txt", content: "done" },
      },
    ],
  });
  const abortedAssistant = buildEmbeddedRunnerAssistant({ ...model, stopReason: "aborted" });
  return makeAttemptResult({
    assistantTexts: [],
    terminal: { kind: "timeout", phase: "prompt", source: "idle", ...(aborted ? { aborted } : {}) },
    toolMetas: [
      { ...(aborted ? { toolCallId: "tool_write" } : {}), toolName: "write", replaySafe: false },
    ],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    messagesSnapshot: [
      { role: "user", content: [{ type: "text", text: prompt }] },
      toolUseAssistant,
      { role: "toolResult", toolCallId: "tool_write", toolName: "write", isError: false },
      abortedAssistant,
    ] as never,
    lastAssistant: abortedAssistant,
    currentAttemptAssistant: abortedAssistant,
    currentAttemptReplayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
  });
}

describe("runEmbeddedAgent prompt timeout fallback handoff", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.prompt-timeout-fallback");
    useOpenAIPlatformAuthFixture();
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each([
    ["timeout", "subagent_announce", "openclaw", undefined],
    ["timeout", "subagent_settle", "codex", undefined],
    ["overloaded", "subagent_settle", "openclaw", undefined],
    ["server_error", "subagent_settle", "openclaw", undefined],
    ["timeout", "subagent_settle", "openclaw", { disableTools: true }],
    ["timeout", "subagent_settle", "openclaw", { toolsAllow: ["message"] }],
  ] as const)(
    "preserves retry delegation and restrictions (%s, %s, %s, %j)",
    async (reason, sourceTool, harness, restriction) => {
      mockedClassifyFailoverReason.mockReturnValue(reason);
      mockedRunEmbeddedAttempt
        .mockResolvedValueOnce(
          promptFailure(
            reason === "timeout"
              ? "LLM request timed out."
              : reason === "server_error"
                ? "HTTP 520: controlled provider server error"
                : "overloaded",
          ),
        )
        .mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["Completion received."] }));

      await runPrompt("run-completion-transient-retry", {
        agentHarnessRuntimeOverride: harness,
        inputProvenance: { kind: "inter_session", sourceTool },
        ...(restriction
          ? {
              ...restriction,
              toolsAllow: "toolsAllow" in restriction ? [...restriction.toolsAllow] : undefined,
            }
          : { config: await fallbackConfig() }),
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      for (const [attempt] of mockedRunEmbeddedAttempt.mock.calls) {
        expect(attempt).toMatchObject({
          ...(restriction ? {} : { provider: "openai", modelId: "gpt-5.4", fallbackReason: null }),
          fallbackActive: false,
          delegationCapability: restriction ? "report_only" : "full",
        });
        if (restriction) {
          continue;
        }
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
        ...model,
      });
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
        expect(attempt.fallbackActive).toBe(true);
        if (harness === "codex") {
          const dynamicTools = ["sessions_send", "sessions_spawn"].map((name) => ({
            type: "function" as const,
            name,
            description: name,
            inputSchema: { type: "object" },
          }));
          const codex = await loadBundledPluginFacade<{
            resolveCodexPromptSnapshotAppServerOptions: () => unknown;
            buildCodexHarnessPromptSnapshot: (params: {
              attempt: EmbeddedRunAttemptParamsV2;
              cwd: string;
              threadId: string;
              dynamicTools: typeof dynamicTools;
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
        ...model,
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
      await runPrompt("run-completion-model-fallback", {
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

  it("throws FailoverError for persistent replay-safe prompt timeouts after transient retries", async () => {
    mockedClassifyFailoverReason.mockReturnValue("timeout");
    mockedRunEmbeddedAttempt.mockResolvedValue(promptFailure());
    const promise = runPrompt("run-prompt-timeout-fallback", { config: await fallbackConfig() });

    await expect(promise).rejects.toBeInstanceOf(MockedFailoverError);
    await expect(promise).rejects.toThrow("LLM request timed out.");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(9);
  });

  it.each([
    { harness: "openclaw", answered: true },
    { harness: "codex", answered: true },
    { harness: "openclaw", answered: false },
  ] as const)(
    "settles an idle timeout without replay under $harness (answered: $answered)",
    async ({ harness, answered }) => {
      const prompt = answered
        ? "Write note.txt, then read it to verify its contents."
        : "Write note.txt";
      mockedClassifyFailoverReason.mockReturnValue("timeout");
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(settledWriteTimeout(prompt, answered));
      if (answered) {
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(
          completedAttempt("The note was written once and verified."),
        );
        mockedBuildEmbeddedRunPayloads.mockImplementation(({ assistantTexts }) =>
          assistantTexts.map((text) => ({ text })),
        );
      } else {
        mockedRunEmbeddedAttempt.mockResolvedValue(completedAttempt());
      }
      const result = await runPrompt("run-post-tool-idle-continuation", {
        ...(answered ? { agentHarnessRuntimeOverride: harness, prompt } : {}),
        config: await fallbackConfig(),
      });
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(answered ? 2 : 3);
      if (!answered) {
        expect(result.meta.executionTrace?.fallbackUsed).not.toBe(true);
        expect(result.meta.error).toMatchObject({ kind: "incomplete_turn" });
        expect(result.payloads).toEqual([
          { text: expect.stringContaining("model idle timeout"), isError: true },
        ]);
        expect(JSON.stringify(result.payloads)).not.toContain("no final summary was produced");
        return;
      }
      expect(result.payloads).toEqual([{ text: "The note was written once and verified." }]);
      expect(result.meta.executionTrace?.fallbackUsed).toBe(false);
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
});
