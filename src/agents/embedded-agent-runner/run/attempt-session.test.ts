import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../../../infra/embedded-plugin-approval-broker.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../../../logging/diagnostic-session-state.js";
import { registerMemoryPromptPreparation } from "../../../plugins/memory-state.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import { recordLoopOutcome } from "../../agent-tools.before-tool-call.diagnostics.js";
import type { AgentTool } from "../../runtime/index.js";
import { agentSessionSetPromptPreparation } from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/index.js";
import { admitToolCallBatch } from "../../tool-loop-admission.js";
import { recordToolCall } from "../../tool-loop-detection.js";
import * as toolSearch from "../../tool-search.js";
import * as embeddedSystemPrompt from "../system-prompt.js";
import { withPromptFixture } from "./attempt-system-prompt.sandbox-info.test-support.js";
import {
  createSemanticStallReplanState,
  type SemanticStallReplanState,
} from "./semantic-stall-replan.js";
import { createRunToolOutcomeState } from "./tool-outcome-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const EXPECTED_REPLAN_INSTRUCTION =
  "The recent tool trajectory is strongly stalled. Reassess the active task and take one materially different, safe next step; do not repeat the stalled action.";

const hoisted = vi.hoisted(() => ({
  applyAgentAutoCompactionGuard: vi.fn(),
  applyAgentCompactionSettingsFromConfig: vi.fn(),
  applySystemPromptToSession: vi.fn(),
  buildEmbeddedExtensionFactories: vi.fn(),
  createAgentSessionForEmbeddedRunner: vi.fn(),
  createEmbeddedAgentResourceLoader: vi.fn(),
  createPreparedEmbeddedAgentSettingsManager: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  installMessageToolOnlyTerminalHook: vi.fn(),
  prepareEmbeddedAttemptClientTools: vi.fn(),
  resolveEffectiveCompactionMode: vi.fn(),
  isSilentOverflowProneModel: vi.fn(),
  resolveToolSearchCatalogTool: vi.fn(),
  toToolDefinitions: vi.fn(),
  wrapToolDefinition: vi.fn(),
  notifyToolActivity: vi.fn(),
  evaluateDecision: vi.fn(),
}));

vi.mock("../../../decisions/runtime.js", () => ({
  evaluateDecision: hoisted.evaluateDecision,
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
}));
vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: hoisted.createPreparedEmbeddedAgentSettingsManager,
}));
vi.mock("../../agent-settings.js", () => ({
  applyAgentAutoCompactionGuard: hoisted.applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig: hoisted.applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel: hoisted.isSilentOverflowProneModel,
  resolveEffectiveCompactionMode: hoisted.resolveEffectiveCompactionMode,
}));
vi.mock("../../agent-tool-definition-adapter.js", () => ({
  toToolDefinitions: hoisted.toToolDefinitions,
}));
vi.mock("../../sessions/sdk.js", () => ({
  createAgentSessionForEmbeddedRunner: hoisted.createAgentSessionForEmbeddedRunner,
}));
vi.mock("../../sessions/tools/tool-definition-wrapper.js", () => ({
  wrapToolDefinition: hoisted.wrapToolDefinition,
}));
vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: hoisted.buildEmbeddedExtensionFactories,
}));
vi.mock("../logger.js", () => ({ log: { info: vi.fn() } }));
vi.mock("../resource-loader.js", () => ({
  createEmbeddedAgentResourceLoader: hoisted.createEmbeddedAgentResourceLoader,
}));
vi.mock("./attempt-client-tools.js", () => ({
  prepareEmbeddedAttemptClientTools: hoisted.prepareEmbeddedAttemptClientTools,
}));
vi.mock("./message-tool-terminal.js", () => ({
  installMessageToolOnlyTerminalHook: hoisted.installMessageToolOnlyTerminalHook,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: hoisted.notifyToolActivity,
}));

import { prepareEmbeddedAttemptAgentSession } from "./attempt-session-prepare.js";

const attempt = {
  authStorage: { id: "auth" },
  config: {},
  contextTokenBudget: 32_000,
  model: { id: "model-1", api: "anthropic-messages" },
  modelId: "model-1",
  modelRegistry: { id: "registry" },
  provider: "anthropic",
  prompt: "prompt",
  runId: "run-1",
  sessionId: "session-1",
  sourceReplyDeliveryMode: "message_tool_only",
  timeoutMs: 30_000,
  workspaceDir: "/workspace",
} as unknown as EmbeddedRunAttemptParams;

function createInput(options?: { activationError?: Error }) {
  const events: string[] = [];
  const settingsManager = { id: "settings" };
  const resourceLoader = {
    reload: vi.fn(async () => {
      events.push("resource-reload");
    }),
  };
  const setActiveToolsByName = vi.fn(() => {
    events.push("activate-tools");
    if (options?.activationError) {
      throw options.activationError;
    }
  });
  const setPromptPreparation = vi.fn<AgentSession[typeof agentSessionSetPromptPreparation]>();
  const activeSession = {
    [agentSessionSetPromptPreparation]: setPromptPreparation,
    agent: { id: "agent", subscribe: vi.fn(), state: { systemPrompt: "", tools: [] } },
    setActiveToolsByName,
    replaceCustomTools: vi.fn(),
  } as unknown as AgentSession;
  const sessionManager = { id: "session-manager" };
  const transcriptLifecycle = {
    withTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
  };
  const hookRunner = { id: "hooks" };
  const sessionToolAllowlist = [{ name: "read" }];
  const allCustomTools = [{ name: "custom" }];
  const clientToolRuntime = {
    builtinToolNames: new Set(["read"]),
    coreBuiltinToolNames: new Set(["read"]),
    clientToolCallSlots: [],
    clientToolDefs: [],
    replaySafeToolNames: new Set(["read"]),
    replaySafeTools: new Set(allCustomTools),
    trustedLocalMediaToolNames: new Set(["read"]),
  };
  let onDeliveredSourceReply: (() => void) | undefined;

  hoisted.createPreparedEmbeddedAgentSettingsManager.mockReturnValue(settingsManager);
  hoisted.resolveEffectiveCompactionMode.mockReturnValue("safeguard");
  hoisted.isSilentOverflowProneModel.mockReturnValue(false);
  hoisted.buildEmbeddedExtensionFactories.mockReturnValue([{ id: "extension" }]);
  hoisted.createEmbeddedAgentResourceLoader.mockReturnValue(resourceLoader);
  hoisted.getGlobalHookRunner.mockReturnValue(hookRunner);
  hoisted.prepareEmbeddedAttemptClientTools.mockReturnValue({
    allCustomTools,
    sessionToolAllowlist,
    ...clientToolRuntime,
    refreshTools: vi.fn(),
  });
  hoisted.createAgentSessionForEmbeddedRunner.mockImplementation(async () => {
    events.push("create-session");
    return { session: activeSession };
  });
  hoisted.applySystemPromptToSession.mockImplementation((_session, prompt: string) => {
    activeSession.agent.state.systemPrompt = prompt;
    events.push("apply-system-prompt");
  });
  hoisted.installMessageToolOnlyTerminalHook.mockImplementation(
    (input: { onDeliveredSourceReply?: () => void }) => {
      events.push("install-terminal-hook");
      onDeliveredSourceReply = input.onDeliveredSourceReply;
    },
  );

  return {
    activeSession,
    setPromptPreparation,
    allCustomTools,
    clientToolRuntime,
    events,
    hookRunner,
    input: {
      attempt,
      agentCoreThinkingLevel: "high" as const,
      agentDir: "/agent",
      clientToolPreparation: {
        codeModeControlsEnabledForRun: true,
        deferredDirectoryToolsCallable: false,
      } as never,
      effectiveCwd: "/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      initialSystemPrompt: "system prompt",
      markStage: (stage: string) => events.push(`stage:${stage}`),
      onSessionCreated: (session: AgentSession) => {
        expect(session).toBe(activeSession);
        events.push("publish-session");
      },
      onSystemPromptChanged: (systemPrompt: string) => {
        expect(systemPrompt).toBe("system prompt");
        events.push("publish-system-prompt");
      },
      runAbortSignal: new AbortController().signal,
      sessionAgentId: "agent-1",
      transcriptLifecycle: transcriptLifecycle as never,
      sessionManager: sessionManager as never,
    },
    onDeliveredSourceReply: () => onDeliveredSourceReply?.(),
    resourceLoader,
    setActiveToolsByName,
    sessionToolAllowlist,
    settingsManager,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.evaluateDecision.mockReset();
  resetDiagnosticSessionStateForTest();
  vi.spyOn(toolSearch, "resolveToolSearchCatalogTool").mockImplementation(
    hoisted.resolveToolSearchCatalogTool,
  );
  vi.spyOn(embeddedSystemPrompt, "applySystemPromptToSession").mockImplementation(
    hoisted.applySystemPromptToSession,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prepareEmbeddedAttemptAgentSession", () => {
  it("cancels a hydrated directory tool's approval with its captured permission generation", async () => {
    const fixture = createInput();
    const generation = new AbortController();
    fixture.input.clientToolPreparation = {
      codeModeControlsEnabledForRun: false,
      deferredDirectoryToolsCallable: true,
      getToolAbortSignal: () => generation.signal,
    } as never;
    await prepareEmbeddedAttemptAgentSession(fixture.input);
    const { toToolDefinitions } = await vi.importActual<
      typeof import("../../agent-tool-definition-adapter.js")
    >("../../agent-tool-definition-adapter.js");
    const { wrapToolDefinition } = await vi.importActual<
      typeof import("../../sessions/tools/tool-definition-wrapper.js")
    >("../../sessions/tools/tool-definition-wrapper.js");
    hoisted.toToolDefinitions.mockImplementation(toToolDefinitions);
    hoisted.wrapToolDefinition.mockImplementation(wrapToolDefinition);
    hoisted.getGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "before_tool_call",
      runBeforeToolCall: async () => ({
        requireApproval: { title: "MCP write", description: "Approve remote mutation" },
      }),
    });
    const execute = vi.fn(async () => ({ content: [], details: { changed: true } }));
    hoisted.resolveToolSearchCatalogTool.mockReturnValue(
      wrapToolWithAbortSignal(
        {
          name: "mcp_write",
          label: "Write",
          description: "Write",
          parameters: Type.Object({}),
          execute,
        },
        generation.signal,
      ),
    );
    const previousMode = isEmbeddedMode();
    const previousBroker = getEmbeddedPluginApprovalBroker();
    const broker = new EmbeddedPluginApprovalBroker();
    const requested = createDeferredCore();
    broker.subscribe((event) => {
      if (event.event === "plugin.approval.requested") {
        requested.resolve();
      }
    });
    setEmbeddedMode(true);
    setEmbeddedPluginApprovalBroker(broker);
    const resolveDeferredTool =
      hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0]![0].resolveDeferredTool;
    const tool = resolveDeferredTool({ toolCall: { name: "mcp_write" } });
    const settled = Promise.allSettled([tool.execute("deferred-write", {})]);
    try {
      await requested.promise;
      expect(broker.listPending()).toHaveLength(1);
      generation.abort(new Error("Permission change"));
      expect(broker.listPending()).toHaveLength(0);
      await settled;
      expect(execute).not.toHaveBeenCalled();
    } finally {
      broker.stop();
      await settled;
      setEmbeddedPluginApprovalBroker(previousBroker);
      setEmbeddedMode(previousMode);
    }
  });

  it.each(["live", "closed"] as const)(
    "publishes prepared memory through the registered session consumer only for a %s admission",
    async (lifetime) => {
      await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), async () => {
        await withPromptFixture(
          {
            name: "disabled elevation",
            elevated: { enabled: false, allowed: false, defaultLevel: "off" },
            required: false,
          },
          async (promptFixture) => {
            const preparedPrompt = await promptFixture.prepare();
            const fixture = createInput();
            fixture.input.attempt = {
              ...fixture.input.attempt,
              config: promptFixture.attempt.config,
              admittedRunContext: promptFixture.attempt.admittedRunContext,
              abortSignal: promptFixture.abort.signal,
              sessionId: promptFixture.attempt.sessionId,
              sessionKey: promptFixture.attempt.sessionKey,
              runId: promptFixture.attempt.runId,
              workspaceDir: promptFixture.attempt.workspaceDir,
              model: promptFixture.attempt.model,
              modelId: promptFixture.attempt.modelId,
              provider: promptFixture.attempt.provider,
            };
            fixture.input.initialSystemPrompt = preparedPrompt.systemPromptText;
            fixture.input.effectiveCwd = promptFixture.attempt.workspaceDir;
            fixture.input.sessionAgentId = "main";
            fixture.input.runAbortSignal = promptFixture.abort.signal;
            const publishPrompt = vi.fn();
            fixture.input.onSystemPromptChanged = publishPrompt;
            const session = await prepareEmbeddedAttemptAgentSession(fixture.input);
            const promptBefore = fixture.activeSession.agent.state.systemPrompt;
            const report = preparedPrompt.systemPromptReport;
            if (!report) {
              throw new Error("Expected the actual prompt report");
            }
            const reportBefore = structuredClone(report);
            publishPrompt.mockClear();
            const entered = createDeferredCore();
            const releaseMemory = createDeferredCore();
            registerMemoryPromptPreparation("refresh-publication-fixture", async () => {
              entered.resolve();
              await releaseMemory.promise;
              return ["## Late memory fixture", "Memory prepared for this permission refresh."];
            });
            let refresh:
              | ReturnType<NonNullable<typeof preparedPrompt.prepareToolPrompt>>
              | undefined;
            const preparePermission = vi.fn(() => {
              if (!preparedPrompt.prepareToolPrompt) {
                throw new Error("Expected the real refreshable prompt owner");
              }
              refresh = preparedPrompt.prepareToolPrompt(promptFixture.tools, {
                permissionChanged: true,
              });
              return refresh;
            });
            session.setPermissionPromptPreparation(preparePermission);
            const nextTurnSignal = new AbortController();
            const prepareNextTurn = fixture.activeSession.agent.prepareNextTurn;
            if (!prepareNextTurn) {
              throw new Error("Expected the registered session next-turn consumer");
            }
            const nextTurn = Promise.resolve(
              prepareNextTurn.call(fixture.activeSession.agent, nextTurnSignal.signal),
            );
            const nextTurnSettled = Promise.allSettled([nextTurn]);
            try {
              await Promise.race([
                entered.promise,
                nextTurn.then(() => {
                  throw new Error("Registered consumer finished before memory preparation");
                }),
              ]);
              if (lifetime === "closed") {
                promptFixture.admission.close();
              }
              expect(promptFixture.abort.signal.aborted).toBe(false);
              expect(nextTurnSignal.signal.aborted).toBe(false);
              releaseMemory.resolve();
              const [outcome] = await nextTurnSettled;
              await Promise.allSettled(refresh ? [refresh] : []);
              expect(preparePermission).toHaveBeenCalledTimes(1);
              if (lifetime === "closed") {
                expect({ prompt: fixture.activeSession.agent.state.systemPrompt, report }).toEqual({
                  prompt: promptBefore,
                  report: reportBefore,
                });
                expect(publishPrompt).not.toHaveBeenCalled();
                expect(outcome).toMatchObject({
                  status: "rejected",
                  reason: { message: "admitted run authority is no longer active" },
                });
              } else {
                expect(outcome.status).toBe("fulfilled");
                expect(fixture.activeSession.agent.state.systemPrompt).toContain(
                  "Late memory fixture",
                );
                expect(fixture.activeSession.agent.state.systemPrompt).not.toBe(promptBefore);
                expect(report.systemPrompt.hash).not.toBe(reportBefore.systemPrompt.hash);
                expect(report.systemPrompt.chars).toBe(
                  fixture.activeSession.agent.state.systemPrompt.length,
                );
                expect(publishPrompt).toHaveBeenCalledTimes(1);
              }
            } finally {
              releaseMemory.resolve();
              await Promise.allSettled([nextTurn, ...(refresh ? [refresh] : [])]);
            }
          },
        );
      });
    },
  );

  it("refreshes permission guidance when hook tool caps change without new prompt bytes", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    let currentToolNames = ["read", "write"];
    prepared.setPermissionPromptPreparation(
      async () => () => `Permission tools: ${currentToolNames.join(", ")}`,
    );
    await fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);
    expect(fixture.activeSession.agent.state.systemPrompt).toBe("Permission tools: read, write");

    // A late prompt hook may narrow tools without supplying a new system prompt.
    currentToolNames = ["read"];
    await fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);

    expect(fixture.activeSession.agent.state.systemPrompt).toBe("Permission tools: read");
  });

  it("keeps updated permission tools and prompt when an older next-turn hook finishes later", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    type Snapshot = Awaited<
      ReturnType<NonNullable<typeof fixture.activeSession.agent.prepareNextTurn>>
    >;
    const pending = createDeferredCore<Snapshot>();
    fixture.activeSession.agent.prepareNextTurn = () => pending.promise;
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    const nextTurn = fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);
    const readTool: AgentTool = {
      name: "read",
      label: "Read",
      description: "Current read-only tool",
      parameters: Type.Object({}),
      execute: async () => ({ content: [], details: {} }),
    };
    const currentTools = [readTool];
    fixture.activeSession.agent.state.tools = currentTools;

    prepared.refreshTools();
    prepared.setPermissionPromptPreparation(
      async () => (prompt) => `Permission change: read-only\n${prompt}`,
    );
    pending.resolve({
      context: {
        systemPrompt: "old hook prompt",
        messages: [],
        tools: [{ ...readTool, name: "stale_write" }],
      },
    });

    const snapshot = await nextTurn;
    expect(snapshot?.context?.systemPrompt).toBe("Permission change: read-only\nold hook prompt");
    expect(snapshot?.context?.tools).toEqual(currentTools);
    expect(fixture.activeSession.agent.state.systemPrompt).toBe(snapshot?.context?.systemPrompt);
  });

  it("composes one semantic stall replan with contextual prepare and permission refresh", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const assertActive = vi.fn();
    const state: SemanticStallReplanState = {
      observer: {
        observeOutcome: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        snapshot: vi.fn(() => ({
          trajectoryVersion: 3,
          latestJudgment: {
            verdict: "stalled" as const,
            probability: 0.97,
            evidence: { detector: "generic_repeat", level: "critical" as const, count: 20 },
            trajectorySize: 8,
            trajectoryVersion: 3,
            toolCallOrdinal: 3,
          },
          metrics: {
            observedOutcomes: 3,
            decisionCalls: 1,
            unavailableDecisions: 0,
            invalidDecisions: 0,
            staleDecisions: 0,
            skippedWhilePending: 0,
            candidateFollowOnCalls: 0,
            verdicts: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
          },
        })),
      },
      assertActive,
      used: false,
    };
    fixture.input.attempt = {
      ...fixture.input.attempt,
      semanticStallReplanState: state,
    };
    fixture.activeSession.agent.prepareNextTurn = async () => ({
      context: { systemPrompt: "hook prompt", messages: [], tools: [] },
    });
    fixture.activeSession.agent.prepareNextTurnWithContext = async (_turn, signal) => {
      const snapshot = await fixture.activeSession.agent.prepareNextTurn?.(signal);
      return snapshot ?? undefined;
    };
    const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
    prepared.setPermissionPromptPreparation(async () => (prompt) => `permission\n${prompt}`);
    const contextualHook = fixture.activeSession.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("contextual prepare hook was not installed");
    }

    const messages: never[] = [];
    const result = await contextualHook(
      {
        message: {} as never,
        toolResults: [],
        context: { systemPrompt: "turn prompt", messages, tools: [] },
        newMessages: [],
      },
      new AbortController().signal,
    );

    expect(result?.context?.systemPrompt).toBe(
      `permission\nhook prompt\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
    );
    expect(result?.context?.messages).toEqual([]);
    expect(state.used).toBe(true);
    expect(assertActive).toHaveBeenCalledOnce();
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("system prompt");
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("permission\nhook prompt");

    const second = await contextualHook(
      {
        message: {} as never,
        toolResults: [],
        context: { systemPrompt: "next prompt", messages, tools: [] },
        newMessages: [],
      },
      new AbortController().signal,
    );
    expect(second?.context?.systemPrompt).toBe("permission\nhook prompt");
    expect(assertActive).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "an absent global decision model",
      {
        tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
      } satisfies OpenClawConfig,
      "agent-1",
      undefined,
    ],
    [
      "an empty owning-agent decision model",
      {
        agents: {
          defaults: { experimental: { decisionAssistance: true }, decisionModel: "fixture/judge" },
          entries: { "agent-1": { decisionModel: "" } },
        },
        tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
      } satisfies OpenClawConfig,
      "agent-1",
      undefined,
    ],
    [
      "an unavailable decision provider",
      {
        agents: {
          defaults: { experimental: { decisionAssistance: true }, decisionModel: "fixture/judge" },
        },
        tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
      } satisfies OpenClawConfig,
      "agent-1",
      "unavailable" as const,
    ],
    [
      "a throwing decision provider",
      {
        agents: {
          defaults: { experimental: { decisionAssistance: true }, decisionModel: "fixture/judge" },
        },
        tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
      } satisfies OpenClawConfig,
      "agent-1",
      "error" as const,
    ],
  ])(
    "keeps the prepared next-turn context and deterministic critical stop unchanged with %s",
    async (_label, config, agentId, decisionFailure) => {
      if (decisionFailure === "unavailable") {
        hoisted.evaluateDecision.mockResolvedValue({ status: "unavailable", reason: "transport" });
      } else if (decisionFailure === "error") {
        hoisted.evaluateDecision.mockRejectedValue(new Error("provider failed"));
      }
      const fixture = createInput();
      const runController = new AbortController();
      const laneController = new AbortController();
      const assertActive = vi.fn();
      const outcomeState = createRunToolOutcomeState({
        config,
        agentId,
        signal: runController.signal,
        laneTaskAbortController: laneController,
        assertAdmittedActive: assertActive,
        goal: "Complete the task",
      });
      const semanticState = createSemanticStallReplanState({
        observer: outcomeState.semanticNoProgressObserver,
        mode: outcomeState.resolvedLoopDetectionConfig?.semanticNoProgress,
        assertActive,
      });
      const sessionKey = `disabled-replan-${agentId}-${_label}`;
      const runId = `run-${agentId}`;
      const ctx = {
        agentId,
        sessionKey,
        sessionId: sessionKey,
        runId,
        loopDetection: outcomeState.resolvedLoopDetectionConfig,
        semanticNoProgressObserver: outcomeState.semanticNoProgressObserver,
      };
      const args = { path: "/synthetic/repeated" };
      const result = { content: [{ type: "text", text: "unchanged" }], details: {} };
      for (let index = 0; index < 20; index += 1) {
        const toolCallId = `repeat-${index}`;
        recordToolCall(
          getDiagnosticSessionState({ sessionKey, sessionId: sessionKey }),
          "read",
          args,
          toolCallId,
          outcomeState.resolvedLoopDetectionConfig,
          { runId },
        );
        await recordLoopOutcome({
          ctx,
          toolName: "read",
          toolParams: args,
          toolCallId,
          result,
          toolCallOrdinal: index + 1,
        });
      }
      const critical = await admitToolCallBatch(
        [
          {
            toolCall: {
              type: "toolCall" as const,
              id: "critical",
              name: "read",
              arguments: args,
            },
            args,
          },
        ],
        ctx,
      );

      fixture.input.attempt = {
        ...fixture.input.attempt,
        config,
        semanticStallReplanState: semanticState,
      };
      fixture.activeSession.agent.prepareNextTurnWithContext = async (turn) => ({
        context: turn.context,
      });
      await prepareEmbeddedAttemptAgentSession(fixture.input);
      const prepare = fixture.activeSession.agent.prepareNextTurnWithContext;
      if (!prepare) {
        throw new Error("contextual prepare hook missing");
      }
      const messages: never[] = [];
      const tools: never[] = [];
      const turn = {
        message: {} as never,
        toolResults: [],
        newMessages: [],
        context: { systemPrompt: "original prompt", messages, tools },
      };

      const prepared = await prepare(turn, runController.signal);

      if (decisionFailure) {
        expect(outcomeState.semanticNoProgressObserver?.snapshot().latestJudgment?.verdict).toBe(
          "uncertain",
        );
        expect(hoisted.evaluateDecision).toHaveBeenCalled();
      } else {
        expect(outcomeState.semanticNoProgressObserver).toBeUndefined();
        expect(hoisted.evaluateDecision).not.toHaveBeenCalled();
      }
      expect(semanticState?.used ?? false).toBe(false);
      expect(prepared?.context).toBe(turn.context);
      expect(prepared?.context?.systemPrompt).toBe("original prompt");
      expect(prepared?.context?.messages).toBe(messages);
      expect(prepared?.context?.tools).toBe(tools);
      expect(critical.intervention).toMatchObject({
        kind: "critical-tool-loop",
        detector: "generic_repeat",
        count: 20,
      });
      await outcomeState.semanticNoProgressObserver?.close();
    },
  );

  it("composes a real run-owned stalled judgment through prepared next-turn context", async () => {
    hoisted.evaluateDecision.mockResolvedValue({
      status: "ok",
      provenance: {
        providerId: "fixture",
        rubricVersion: "semantic-no-progress-shadow-v1",
        runtimeGeneration: "fixture",
      },
      result: {
        model: "fixture/judge",
        answers: {
          verdict: { type: "choice", choice: "stalled", probabilities: { stalled: 0.99 } },
        },
      },
    });
    const config: OpenClawConfig = {
      agents: {
        defaults: { experimental: { decisionAssistance: true }, decisionModel: "fixture/judge" },
      },
      tools: { loopDetection: { enabled: true, semanticNoProgress: "replan" } },
    };
    const fixture = createInput();
    const controller = new AbortController();
    const assertActive = vi.fn();
    const outcomeState = createRunToolOutcomeState({
      config,
      agentId: "agent-1",
      signal: controller.signal,
      laneTaskAbortController: new AbortController(),
      assertAdmittedActive: assertActive,
      goal: "Complete the task",
    });
    const semanticState = createSemanticStallReplanState({
      observer: outcomeState.semanticNoProgressObserver,
      mode: outcomeState.resolvedLoopDetectionConfig?.semanticNoProgress,
      assertActive,
    });
    if (!semanticState || !outcomeState.semanticNoProgressObserver) {
      throw new Error("run-owned replan state missing");
    }
    const sessionKey = "real-run-owned-replan";
    const runId = "real-run-owned-replan-run";
    const ctx = {
      agentId: "agent-1",
      sessionKey,
      sessionId: sessionKey,
      runId,
      loopDetection: outcomeState.resolvedLoopDetectionConfig,
      semanticNoProgressObserver: outcomeState.semanticNoProgressObserver,
    };
    const args = { path: "/synthetic/repeated" };
    for (let index = 0; index < 11; index += 1) {
      const toolCallId = `repeat-${index}`;
      recordToolCall(
        getDiagnosticSessionState({ sessionKey, sessionId: sessionKey }),
        "read",
        args,
        toolCallId,
        outcomeState.resolvedLoopDetectionConfig,
        { runId },
      );
      await recordLoopOutcome({
        ctx,
        toolName: "read",
        toolParams: args,
        toolCallId,
        result: "unchanged",
        toolCallOrdinal: index + 1,
      });
    }

    fixture.input.attempt = {
      ...fixture.input.attempt,
      config,
      semanticStallReplanState: semanticState,
    };
    fixture.activeSession.agent.prepareNextTurnWithContext = async (turn) => ({
      context: turn.context,
    });
    await prepareEmbeddedAttemptAgentSession(fixture.input);
    const prepare = fixture.activeSession.agent.prepareNextTurnWithContext;
    if (!prepare) {
      throw new Error("contextual prepare hook missing");
    }
    const messages: never[] = [];
    const tools: never[] = [];
    const prepared = await prepare(
      {
        message: {} as never,
        toolResults: [],
        newMessages: [],
        context: { systemPrompt: "original prompt", messages, tools },
      },
      controller.signal,
    );

    expect(prepared?.context?.systemPrompt).toBe(
      `original prompt\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
    );
    expect(prepared?.context?.messages).toBe(messages);
    expect(prepared?.context?.tools).toBe(tools);
    expect(semanticState.used).toBe(true);
    expect(hoisted.evaluateDecision).toHaveBeenCalledOnce();
    await outcomeState.semanticNoProgressObserver.close();
  });

  it("does not activate semantic observation or replan from model selection alone", () => {
    const assertActive = vi.fn();
    const outcomeState = createRunToolOutcomeState({
      config: {
        agents: {
          defaults: { experimental: { decisionAssistance: true }, decisionModel: "fixture/judge" },
        },
      },
      agentId: "agent-1",
      signal: new AbortController().signal,
      laneTaskAbortController: new AbortController(),
      assertAdmittedActive: assertActive,
      goal: "Complete the task",
    });

    expect(outcomeState.semanticNoProgressObserver).toBeUndefined();
    expect(
      createSemanticStallReplanState({
        observer: outcomeState.semanticNoProgressObserver,
        mode: outcomeState.resolvedLoopDetectionConfig?.semanticNoProgress,
        assertActive,
      }),
    ).toBeUndefined();
    expect(hoisted.evaluateDecision).not.toHaveBeenCalled();
  });

  it.each(["legacy", "context", "metadata"] as const)(
    "retires the instruction before subsequent hook composition (%s)",
    async (kind) => {
      const contextual = kind === "context";
      const fixture = createInput();
      const assertActive = vi.fn();
      fixture.input.attempt = {
        ...fixture.input.attempt,
        semanticStallReplanState: {
          used: false,
          assertActive,
          observer: {
            observeOutcome: async () => undefined,
            close: async () => undefined,
            snapshot: () => ({
              trajectoryVersion: 1,
              latestJudgment: {
                verdict: "stalled",
                probability: 0.99,
                trajectoryVersion: 1,
                evidence: { detector: "generic_repeat", level: "warning", count: 10 },
                trajectorySize: 8,
                toolCallOrdinal: 11,
              },
              metrics: {
                observedOutcomes: 11,
                decisionCalls: 1,
                unavailableDecisions: 0,
                invalidDecisions: 0,
                staleDecisions: 0,
                skippedWhilePending: 0,
                candidateFollowOnCalls: 0,
                verdicts: { progress: 0, stalled: 1, regressing: 0, uncertain: 0 },
              },
            }),
          },
        },
      };
      fixture.activeSession.agent.prepareNextTurn = async () => undefined;
      Reflect.deleteProperty(fixture.activeSession.agent, "prepareNextTurnWithContext");
      if (contextual) {
        fixture.activeSession.agent.prepareNextTurnWithContext = async (turn) => ({
          context: { ...turn.context, systemPrompt: `${turn.context.systemPrompt}\npolicy` },
        });
      }
      if (kind === "metadata") {
        fixture.activeSession.agent.prepareNextTurnWithContext = async () => ({ stop: false });
      }
      await prepareEmbeddedAttemptAgentSession(fixture.input);
      const hook = fixture.activeSession.agent.prepareNextTurnWithContext;
      if (!hook) {
        throw new Error("context-aware replan hook missing");
      }
      const turn = {
        message: {} as never,
        toolResults: [],
        newMessages: [],
        context: { systemPrompt: "base", messages: [], tools: [] },
      };
      const first = await hook(turn, new AbortController().signal);
      expect(first?.context?.systemPrompt).toBe(
        `${contextual ? "base\npolicy" : "base"}\n\n${EXPECTED_REPLAN_INSTRUCTION}`,
      );
      const second = await hook(
        { ...turn, context: first!.context! },
        new AbortController().signal,
      );
      expect(second?.context?.systemPrompt).toBe(contextual ? "base\npolicy\npolicy" : "base");
      expect(assertActive).toHaveBeenCalledOnce();
      expect(fixture.activeSession.agent.state.systemPrompt).toBe("system prompt");
    },
  );

  it("prepares resources and publishes the activated session runtime", async () => {
    const fixture = createInput();

    const result = await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
      "publish-system-prompt",
      "apply-system-prompt",
      "install-terminal-hook",
      "stage:agent-session",
    ]);
    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledTimes(2);
    expect(hoisted.applyAgentCompactionSettingsFromConfig).toHaveBeenCalledOnce();
    expect(hoisted.applyAgentCompactionSettingsFromConfig.mock.invocationCallOrder[0]).toBeLessThan(
      hoisted.applyAgentAutoCompactionGuard.mock.invocationCallOrder[1] ?? 0,
    );
    const sessionCall = hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0];
    expect(sessionCall?.[0]).toMatchObject({ resourceLoader: fixture.resourceLoader });
    expect(sessionCall?.[1]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "caller",
    });
    expect(sessionCall?.[0]).not.toHaveProperty("contextOverflowRecoveryOwner");
    expect(fixture.setActiveToolsByName).toHaveBeenCalledWith(fixture.sessionToolAllowlist);
    expect(result).toEqual(
      expect.objectContaining({
        activeSession: fixture.activeSession,
        allCustomTools: fixture.allCustomTools,
        hookRunner: fixture.hookRunner,
        settingsManager: fixture.settingsManager,
        ...fixture.clientToolRuntime,
      }),
    );
    expect(result.hasDeliveredSourceReply()).toBe(false);
    fixture.onDeliveredSourceReply();
    expect(result.hasDeliveredSourceReply()).toBe(true);
  });

  it("refreshes replacement permissions while replay preparation waits", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const entered = createDeferredCore();
    const release = createDeferredCore<() => void>();
    const originalAdmission = vi.fn();
    const currentAdmission = vi.fn();
    const prepareReplay = vi
      .fn()
      .mockImplementationOnce(() => {
        entered.resolve();
        return release.promise;
      })
      .mockResolvedValue(currentAdmission);
    const prepared = await prepareEmbeddedAttemptAgentSession({
      ...fixture.input,
      prepareInitialUserTurnReplay: prepareReplay,
    });
    prepared.setPermissionPromptPreparation(async () => () => "old permissions");
    const preparation = fixture.setPromptPreparation.mock.lastCall?.[0];
    const pending = preparation!();
    await entered.promise;
    prepared.setPermissionPromptPreparation(async () => () => "current permissions");
    release.resolve(originalAdmission);
    const admit = await pending;
    expect(fixture.activeSession.agent.state.systemPrompt).toBe("current permissions");
    expect(originalAdmission).not.toHaveBeenCalled();
    expect(currentAdmission).not.toHaveBeenCalled();
    admit?.();
    expect(currentAdmission).toHaveBeenCalledOnce();
  });

  it.each(["replace", "replace-reject", "replace-pending", "abort", "current-error"] as const)(
    "discards permission prompt preparation after %s",
    async (closure) => {
      const fixture = createInput();
      fixture.input.onSystemPromptChanged = vi.fn();
      const prepared = await prepareEmbeddedAttemptAgentSession(fixture.input);
      const pending = createDeferredCore<(prompt: string) => string>();
      const entered = createDeferredCore();
      const staleRenderer = vi.fn(() => "stale permission prompt");
      prepared.setPermissionPromptPreparation(() => {
        entered.resolve();
        return pending.promise;
      });
      const controller = new AbortController();
      const nextTurn = fixture.activeSession.agent.prepareNextTurn!(controller.signal);
      const settled = Promise.allSettled([nextTurn]);
      await entered.promise;
      if (closure === "abort") {
        controller.abort();
      } else if (closure !== "current-error") {
        prepared.setPermissionPromptPreparation(async () => () => "current permission prompt");
      }
      if (closure === "replace-reject" || closure === "current-error") {
        pending.reject(new Error("obsolete memory preparation failed"));
      } else if (closure !== "replace-pending") {
        pending.resolve(staleRenderer);
      }
      const [result] = await settled;
      pending.resolve(staleRenderer);
      expect(staleRenderer).not.toHaveBeenCalled();
      const rejected = closure === "abort" || closure === "current-error";
      expect(result.status).toBe(rejected ? "rejected" : "fulfilled");
      if (closure === "current-error") {
        expect(result).toMatchObject({ reason: { message: "obsolete memory preparation failed" } });
      }
      if (!rejected) {
        expect(fixture.activeSession.agent.state.systemPrompt).toBe("current permission prompt");
      }
    },
  );

  it("fences initial prompt preparation after run cancellation without a policy change", async () => {
    const fixture = createInput();
    const controller = new AbortController();
    fixture.input.runAbortSignal = controller.signal;
    await prepareEmbeddedAttemptAgentSession(fixture.input);
    const prepare = fixture.setPromptPreparation.mock.lastCall?.[0];
    expect(prepare).toBeTypeOf("function");
    const reason = new Error("run closed during SDK prompt hooks");
    controller.abort(reason);
    await expect(prepare!()).rejects.toBe(reason);
  });

  it.each([false, true])(
    "checks replay ownership synchronously after preparation with cancellation %s",
    async (cancel) => {
      const fixture = createInput();
      const controller = new AbortController();
      const assertInitialUserTurnReplay = vi.fn();
      await prepareEmbeddedAttemptAgentSession({
        ...fixture.input,
        runAbortSignal: controller.signal,
        prepareInitialUserTurnReplay: async () => assertInitialUserTurnReplay,
      });
      const admit = await fixture.setPromptPreparation.mock.lastCall?.[0]?.();
      expect(assertInitialUserTurnReplay).not.toHaveBeenCalled();
      const reason = new Error("closed after preparation");
      if (cancel) {
        controller.abort(reason);
        expect(() => admit?.()).toThrow(reason);
        expect(assertInitialUserTurnReplay).not.toHaveBeenCalled();
      } else {
        admit?.();
        expect(assertInitialUserTurnReplay).toHaveBeenCalledOnce();
      }
    },
  );

  it("leaves overflow recovery with the session when no model budget was resolved", async () => {
    const fixture = createInput();
    fixture.input.attempt = {
      ...fixture.input.attempt,
      contextTokenBudget: undefined,
    };

    await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0]?.[1]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "session",
    });
  });

  it("publishes session ownership before activation can fail", async () => {
    const fixture = createInput({ activationError: new Error("activation failed") });

    await expect(prepareEmbeddedAttemptAgentSession(fixture.input)).rejects.toThrow(
      "activation failed",
    );

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
    ]);
  });
});
