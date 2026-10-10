import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEmbeddedMode, setEmbeddedMode } from "../../../infra/embedded-mode.js";
import {
  EmbeddedPluginApprovalBroker,
  getEmbeddedPluginApprovalBroker,
  setEmbeddedPluginApprovalBroker,
} from "../../../infra/embedded-plugin-approval-broker.js";
import { registerMemoryPromptPreparation } from "../../../plugins/memory-state.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import type { AgentTool } from "../../runtime/index.js";
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/index.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import * as toolSearch from "../../tool-search.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
  prepareSessionSystemPrompt,
} from "../session-prompt-state.js";
import { withPromptFixture } from "./attempt-system-prompt.sandbox-info.test-support.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  applyAgentAutoCompactionGuard: vi.fn(),
  buildEmbeddedExtensionFactories: vi.fn(),
  createAgentSession: vi.fn(),
  DefaultResourceLoader: vi.fn<new () => { reload: () => Promise<void> }>(),
  createPreparedEmbeddedAgentSettingsManager: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  installMessageToolOnlyTerminalHook: vi.fn(),
  installToolAuthoredSourceReplyTerminalHook: vi.fn(),
  prepareEmbeddedAttemptClientTools: vi.fn(),
  resolveEffectiveCompactionMode: vi.fn(),
  isSilentOverflowProneModel: vi.fn(),
  resolveToolSearchCatalogTool: vi.fn(),
  toToolDefinitions: vi.fn(),
  wrapToolDefinition: vi.fn(),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
}));
vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: hoisted.createPreparedEmbeddedAgentSettingsManager,
}));
// mock-isolation: Keep configuration policy outside the session assembly fixture.
vi.mock("../../agent-settings.js", () => ({
  applyAgentAutoCompactionGuard: hoisted.applyAgentAutoCompactionGuard,
  isSilentOverflowProneModel: hoisted.isSilentOverflowProneModel,
  resolveEffectiveCompactionMode: hoisted.resolveEffectiveCompactionMode,
}));
vi.mock("../../agent-tool-definition-adapter.js", () => ({
  toToolDefinitions: hoisted.toToolDefinitions,
}));
// mock-isolation: Keep session storage and provider runtime outside the preparation fixture.
vi.mock("../../sessions/sdk.js", () => ({
  createAgentSession: hoisted.createAgentSession,
}));
vi.mock("../../sessions/tools/tool-definition-wrapper.js", () => ({
  wrapToolDefinition: hoisted.wrapToolDefinition,
}));
vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: hoisted.buildEmbeddedExtensionFactories,
}));
vi.mock("../logger.js", () => ({ log: { info: vi.fn() } }));
vi.mock("../../sessions/resource-loader.js", () => ({
  DefaultResourceLoader: hoisted.DefaultResourceLoader,
}));
vi.mock("./attempt-client-tools.js", () => ({
  prepareEmbeddedAttemptClientTools: hoisted.prepareEmbeddedAttemptClientTools,
}));
vi.mock("./message-tool-terminal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./message-tool-terminal.js")>()),
  installMessageToolOnlyTerminalHook: hoisted.installMessageToolOnlyTerminalHook,
  installToolAuthoredSourceReplyTerminalHook: hoisted.installToolAuthoredSourceReplyTerminalHook,
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
  const queuePromptContext = vi.fn<
    (message: Parameters<AgentSession[typeof agentSessionQueuePromptContext]>[0]) => () => void
  >(() => () => {});
  const activeSession = {
    [agentSessionSetPromptPreparation]: setPromptPreparation,
    [agentSessionQueuePromptContext]: queuePromptContext,
    agent: { id: "agent", subscribe: vi.fn(), state: { systemPrompt: "", tools: [] } },
    setActiveToolsByName,
    setBaseSystemPrompt: vi.fn((prompt: string) => {
      activeSession.agent.state.systemPrompt = prompt;
      events.push("apply-system-prompt");
    }),
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
    sourceReplyCapableToolNames: new Set(["order_status"]),
  };
  let onDeliveredSourceReply: (() => void) | undefined;
  let onCompletedSourceReply: (() => void) | undefined;

  hoisted.createPreparedEmbeddedAgentSettingsManager.mockReturnValue(settingsManager);
  hoisted.resolveEffectiveCompactionMode.mockReturnValue("safeguard");
  hoisted.isSilentOverflowProneModel.mockReturnValue(false);
  hoisted.buildEmbeddedExtensionFactories.mockReturnValue([{ id: "extension" }]);
  hoisted.DefaultResourceLoader.mockImplementation(
    class {
      reload = resourceLoader.reload;
    },
  );
  hoisted.getGlobalHookRunner.mockReturnValue(hookRunner);
  hoisted.prepareEmbeddedAttemptClientTools.mockReturnValue({
    allCustomTools,
    sessionToolAllowlist,
    ...clientToolRuntime,
    refreshTools: vi.fn(),
  });
  hoisted.createAgentSession.mockImplementation(async () => {
    events.push("create-session");
    return { session: activeSession };
  });
  hoisted.installMessageToolOnlyTerminalHook.mockImplementation(
    (input: { onDeliveredSourceReply?: () => void; onCompletedSourceReply?: () => void }) => {
      events.push("install-terminal-hook");
      onDeliveredSourceReply = input.onDeliveredSourceReply;
      onCompletedSourceReply = input.onCompletedSourceReply;
    },
  );

  return {
    activeSession,
    setPromptPreparation,
    queuePromptContext,
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
    onCompletedSourceReply: () => onCompletedSourceReply?.(),
    onDeliveredSourceReply: () => onDeliveredSourceReply?.(),
    resourceLoader,
    setActiveToolsByName,
    sessionToolAllowlist,
    settingsManager,
  };
}

function createSystemUpdateInput() {
  const fixture = createInput();
  const pinnedPrompt = "## Tools\nread, write";
  fixture.input.initialSystemPrompt = pinnedPrompt;
  fixture.input.onSystemPromptChanged = vi.fn();
  fixture.activeSession.agent.state.messages = [
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Read complete." }],
      isError: false,
      timestamp: 1,
    },
  ];
  const steer = fixture.queuePromptContext;
  const state = getEmbeddedSessionPromptState("permission-system-updates");
  const prepareSystemPromptUpdate = vi.fn((systemPrompt: string, _freshlyRendered?: boolean) =>
    prepareSessionSystemPrompt({
      state,
      routeKey: "anthropic/claude-opus-5/anthropic-messages",
      systemPrompt,
      entries: [],
    }),
  );
  prepareSystemPromptUpdate(pinnedPrompt).commit();
  prepareSystemPromptUpdate.mockClear();
  const prepareNextRequest = async (signal: AbortSignal) => {
    const snapshot = await fixture.activeSession.agent.prepareNextTurn?.(signal);
    return snapshot?.prepareContinuation
      ? snapshot.prepareContinuation(
          snapshot.context ?? {
            systemPrompt: fixture.activeSession.agent.state.systemPrompt,
            messages: fixture.activeSession.agent.state.messages,
            tools: fixture.activeSession.agent.state.tools,
          },
        )
      : snapshot;
  };
  return { fixture, pinnedPrompt, steer, state, prepareSystemPromptUpdate, prepareNextRequest };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(toolSearch, "resolveToolSearchCatalogTool").mockImplementation(
    hoisted.resolveToolSearchCatalogTool,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  clearEmbeddedSessionPromptStates(["permission-system-updates"]);
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
    const resolveDeferredTool = hoisted.createAgentSession.mock.calls[0]![0].resolveDeferredTool;
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

  it.each([false, true])(
    "refreshes permission guidance with in-history updates %s",
    async (inHistorySystemUpdates) => {
      const { fixture, pinnedPrompt, steer, prepareSystemPromptUpdate, prepareNextRequest } =
        createSystemUpdateInput();
      const prepared = await prepareEmbeddedAttemptAgentSession({
        ...fixture.input,
        prepareSystemPromptUpdate: inHistorySystemUpdates ? prepareSystemPromptUpdate : undefined,
      });
      let currentPrompt = pinnedPrompt;
      prepared.setPermissionPromptPreparation(async () => () => currentPrompt);
      const signal = new AbortController().signal;
      await prepareNextRequest(signal);
      expect(steer).not.toHaveBeenCalled();
      if (inHistorySystemUpdates) {
        expect(prepareSystemPromptUpdate).toHaveBeenLastCalledWith(pinnedPrompt, false);
      }

      currentPrompt =
        "## Tools\nread\n\n<!-- openclaw:attempt:PERMISSION -->\n## Permission change\nThe operator changed workspace permissions to read-only.\n<!-- /openclaw:attempt:PERMISSION -->";
      prepared.setPermissionPromptPreparation(async () =>
        Object.assign(() => currentPrompt, { freshlyRendered: true }),
      );
      await prepareNextRequest(signal);
      expect(fixture.activeSession.agent.state.systemPrompt).toBe(
        inHistorySystemUpdates ? pinnedPrompt : currentPrompt,
      );
      if (inHistorySystemUpdates) {
        expect(prepareSystemPromptUpdate).toHaveBeenLastCalledWith(currentPrompt, true);
        expect(steer).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            role: "custom",
            customType: "openclaw.system-update",
            content: expect.stringContaining("## Tools\nread"),
            details: { kind: "prompt-update", turnScoped: false },
          }),
        );
        expect(steer.mock.calls[0]?.[0].content).toContain(
          "## Permission change\nThe operator changed workspace permissions to read-only.",
        );
        await prepareNextRequest(signal);
        expect(steer).toHaveBeenCalledTimes(1);

        fixture.activeSession.agent.state.messages.push(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Done." }],
          }),
        );
        currentPrompt = "## Tools\nnone";
        await fixture.activeSession.agent.prepareNextTurn?.(signal);
        expect(fixture.activeSession.agent.state.systemPrompt).toBe(pinnedPrompt);
        expect(steer).toHaveBeenCalledTimes(1);
      } else {
        expect(steer).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps an initial update pending until replay admission succeeds", async () => {
    const { fixture, pinnedPrompt, steer, state, prepareSystemPromptUpdate } =
      createSystemUpdateInput();
    const prepareReplay = vi
      .fn()
      .mockRejectedValueOnce(new Error("replay changed"))
      .mockResolvedValue(undefined);
    const prepared = await prepareEmbeddedAttemptAgentSession({
      ...fixture.input,
      prepareSystemPromptUpdate,
      prepareInitialUserTurnReplay: prepareReplay,
    });
    prepared.setPermissionPromptPreparation(async () => () => "## Tools\nread");
    const prepare = fixture.setPromptPreparation.mock.lastCall?.[0];
    await expect(prepare!()).rejects.toThrow("replay changed");
    expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
    expect(steer).not.toHaveBeenCalled();

    const admit = await prepare!();
    expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
    expect(steer).not.toHaveBeenCalled();
    await admit?.((commit) => commit?.());
    expect(state.pendingSystemPrompt?.renderedPrefix).toBe("## Tools\nread");
    expect(steer).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content: expect.stringContaining("## Tools\nread"),
      }),
    );
    expect(fixture.activeSession.agent.state.systemPrompt).toBe(pinnedPrompt);
  });

  it.each(["replace", "abort"] as const)(
    "does not commit an awaited system update after %s",
    async (closure) => {
      const { fixture, pinnedPrompt, steer, state, prepareSystemPromptUpdate, prepareNextRequest } =
        createSystemUpdateInput();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let first = true;
      const prepared = await prepareEmbeddedAttemptAgentSession({
        ...fixture.input,
        prepareSystemPromptUpdate: async (prompt) => {
          const projection = prepareSystemPromptUpdate(prompt);
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return projection;
        },
      });
      prepared.setPermissionPromptPreparation(async () => () => "## Tools\nstale");
      const controller = new AbortController();
      const nextTurn = prepareNextRequest(controller.signal);
      const settled = Promise.allSettled([nextTurn]);
      await entered.promise;
      if (closure === "abort") {
        controller.abort(new Error("run closed"));
      } else {
        prepared.setPermissionPromptPreparation(async () => () => "## Tools\nread");
      }
      release.resolve();
      const [result] = await settled;
      expect(fixture.activeSession.agent.state.systemPrompt).toBe(pinnedPrompt);
      if (closure === "abort") {
        expect(result).toMatchObject({ status: "rejected", reason: { message: "run closed" } });
        expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
        expect(steer).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("fulfilled");
        expect(state.pendingSystemPrompt?.renderedPrefix).toBe("## Tools\nread");
        expect(steer).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            content: expect.stringContaining("## Tools\nread"),
          }),
        );
        expect(steer.mock.calls[0]?.[0].content).not.toContain("stale");
      }
    },
  );

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

  it("prepares resources and publishes the activated session runtime", async () => {
    const fixture = createInput();
    fixture.input.initialSystemPrompt = "  system prompt\n";
    fixture.input.onSystemPromptChanged = vi.fn(() => {
      fixture.events.push("publish-system-prompt");
    });
    const onCompletedSourceReplyDelivered = vi.fn();
    fixture.input.attempt.onCompletedSourceReplyDelivered = onCompletedSourceReplyDelivered;

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
    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledOnce();
    const sessionCall = hoisted.createAgentSession.mock.calls[0];
    expect(sessionCall?.[0]).toMatchObject({ resourceLoader: fixture.resourceLoader });
    expect(sessionCall?.[0]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "caller",
      cleanupProviderSessionResourcesOnDispose: false,
    });
    expect(fixture.activeSession.agent.state.systemPrompt).toBe("system prompt");
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("  system prompt\n");
    expect(fixture.setActiveToolsByName).toHaveBeenCalledWith(fixture.sessionToolAllowlist);
    // Only author-declared reply tools may end the batch with their own reply.
    expect(hoisted.installToolAuthoredSourceReplyTerminalHook).toHaveBeenCalledWith({
      agent: fixture.activeSession.agent,
      sourceReplyCapableToolNames: new Set(["order_status"]),
    });
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
    expect(onCompletedSourceReplyDelivered).not.toHaveBeenCalled();
    fixture.onCompletedSourceReply();
    fixture.onCompletedSourceReply();
    expect(onCompletedSourceReplyDelivered).toHaveBeenCalledOnce();
  });

  it("refreshes replacement permissions while replay preparation waits", async () => {
    const fixture = createInput();
    fixture.input.onSystemPromptChanged = vi.fn();
    const entered = createDeferredCore();
    const release = createDeferredCore<(onAdmitted: () => void) => Promise<void>>();
    const originalAdmission = vi.fn(async (onAdmitted: () => void) => onAdmitted());
    const currentAdmission = vi.fn(async (onAdmitted: () => void) => onAdmitted());
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
    await admit?.((commit) => commit?.());
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
    "checks replay ownership before admission with cancellation %s",
    async (cancel) => {
      const fixture = createInput();
      const controller = new AbortController();
      const assertInitialUserTurnReplay = vi.fn(async (onAdmitted: () => void) => onAdmitted());
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
        await expect(admit?.((commit) => commit?.())).rejects.toThrow(reason);
        expect(assertInitialUserTurnReplay).not.toHaveBeenCalled();
      } else {
        await admit?.((commit) => commit?.());
        expect(assertInitialUserTurnReplay).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(["allow", "abort", "replace"] as const)(
    "rechecks permission ownership inside awaited replay admission: %s",
    async (closure) => {
      const { fixture, pinnedPrompt, steer, state, prepareSystemPromptUpdate } =
        createSystemUpdateInput();
      const controller = new AbortController();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const prepared = await prepareEmbeddedAttemptAgentSession({
        ...fixture.input,
        runAbortSignal: controller.signal,
        prepareSystemPromptUpdate,
        prepareInitialUserTurnReplay: async () => async (onAdmitted) => {
          entered.resolve();
          await release.promise;
          onAdmitted();
        },
      });
      prepared.setPermissionPromptPreparation(async () => () => "## Tools\nread");
      const admit = await fixture.setPromptPreparation.mock.lastCall?.[0]?.();
      const start = vi.fn();
      const admission = admit?.((commit) => {
        commit?.();
        start();
      });
      const settled = Promise.allSettled([admission]);
      await entered.promise;
      expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
      if (closure === "abort") {
        controller.abort(new Error("run closed during replay admission"));
      } else if (closure === "replace") {
        prepared.setPermissionPromptPreparation(async () => () => "replacement permissions");
      }
      release.resolve();
      const [result] = await settled;
      if (closure === "allow") {
        expect(result.status).toBe("fulfilled");
        expect(start).toHaveBeenCalledOnce();
        expect(steer).toHaveBeenCalledOnce();
      } else {
        expect(result.status).toBe("rejected");
        expect(start).not.toHaveBeenCalled();
        expect(steer).not.toHaveBeenCalled();
        expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
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

    expect(hoisted.createAgentSession.mock.calls[0]?.[0]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "session",
    });
  });

  it.each([
    ["settled-tool-finalization", true],
    [undefined, false],
  ] as const)("sets compactionForbidden for operation %s to %s", async (operation, expected) => {
    const fixture = createInput();
    fixture.input.attempt = { ...fixture.input.attempt, operation };

    await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledWith(
      expect.objectContaining({ compactionForbidden: expected }),
    );
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
