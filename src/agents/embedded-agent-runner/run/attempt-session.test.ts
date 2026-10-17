import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
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
import {
  createAnthropicModelFixture,
  createCompactionEvent,
  expectCompactionResult,
  runCompactionScenario,
  structuredSummary,
  testing as safeguardTesting,
  toolResultMessage,
} from "../../agent-hooks/compaction-safeguard.test-support.js";
import { wrapToolWithAbortSignal } from "../../agent-tools.abort.js";
import {
  agentSessionQueuePromptContext,
  agentSessionSetPromptPreparation,
} from "../../sessions/agent-session-prompting.js";
import type { AgentSession } from "../../sessions/index.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import * as toolSearch from "../../tool-search.js";
import {
  clearEmbeddedSessionPromptStates,
  retainEmbeddedSessionPromptState,
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
  installMessageToolTerminalHook: vi.fn(),
  prepareEmbeddedAttemptClientTools: vi.fn(),
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
  isSilentOverflowProneModel: vi.fn(() => false),
  resolveEffectiveCompactionMode: vi.fn(() => "safeguard"),
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
  installMessageToolTerminalHook: hoisted.installMessageToolTerminalHook,
}));

import { prepareEmbeddedAttemptAgentSession as prepareSession } from "./attempt-session-prepare.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type SessionInput = Parameters<typeof prepareSession>[0];

const attempt = {
  config: {},
  contextTokenBudget: 32_000,
  model: { id: "model-1", api: "anthropic-messages" },
  modelId: "model-1",
  provider: "anthropic",
  runId: "run-1",
  sessionId: "session-1",
} as unknown as EmbeddedRunAttemptParams;

function gate<T = void>() {
  const entered = createDeferredCore();
  const released = createDeferredCore<T>();
  return {
    entered: entered.promise,
    release: released.resolve,
    reject: released.reject,
    wait: () => {
      entered.resolve();
      return released.promise;
    },
  };
}

function createInput(options?: { terminalHookError?: Error }) {
  const events: string[] = [];
  const settingsManager = { id: "settings", getCompactionEnabled: () => true };
  const resourceLoader = { reload: vi.fn(async () => void events.push("resource-reload")) };
  const setPromptPreparation = vi.fn<AgentSession[typeof agentSessionSetPromptPreparation]>();
  const queuePromptContext = vi.fn<
    (message: Parameters<AgentSession[typeof agentSessionQueuePromptContext]>[0]) => () => void
  >(() => () => {});
  const activeSession = {
    [agentSessionSetPromptPreparation]: setPromptPreparation,
    [agentSessionQueuePromptContext]: queuePromptContext,
    agent: { id: "agent", subscribe: vi.fn(), state: { systemPrompt: "", tools: [] } },
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
  };
  let onDeliveredSourceReply: (() => void) | undefined;

  hoisted.createPreparedEmbeddedAgentSettingsManager.mockReturnValue(settingsManager);
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
  hoisted.createAgentSession.mockImplementation(
    async (sessionOptions: { systemPrompt: string }) => {
      events.push("create-session");
      activeSession.agent.state.systemPrompt = sessionOptions.systemPrompt;
      return { session: activeSession };
    },
  );
  hoisted.installMessageToolTerminalHook.mockImplementation(
    (input: { onDeliveredSourceReply?: () => void }) => {
      events.push("install-terminal-hook");
      if (options?.terminalHookError) {
        throw options.terminalHookError;
      }
      onDeliveredSourceReply = input.onDeliveredSourceReply;
    },
  );

  const input = {
    attempt,
    agentCoreThinkingLevel: "high" as const,
    agentDir: "/agent",
    clientToolPreparation: {
      codeModeControlsEnabledForRun: true,
      deferredDirectoryToolsCallable: false,
    } as never,
    effectiveCwd: "/workspace",
    effectiveWorkspace: "/workspace",
    getCurrentAttemptPluginMetadataSnapshot: () => undefined,
    initialSystemPrompt: "system prompt",
    markStage: (stage: string) => events.push(`stage:${stage}`),
    onSessionCreated: vi.fn((_session: AgentSession) => void events.push("publish-session")),
    onSystemPromptChanged: vi.fn((_prompt: string) => void events.push("publish-system-prompt")),
    runAbortSignal: new AbortController().signal,
    sessionAgentId: "agent-1",
    transcriptLifecycle: transcriptLifecycle as never,
    sessionManager: sessionManager as never,
  } satisfies SessionInput;
  return {
    input,
    prepare: (overrides: Partial<SessionInput> = {}) => prepareSession({ ...input, ...overrides }),
    activeSession,
    setPromptPreparation,
    queuePromptContext,
    allCustomTools,
    clientToolRuntime,
    events,
    hookRunner,
    onDeliveredSourceReply: () => onDeliveredSourceReply?.(),
    resourceLoader,
    sessionToolAllowlist,
    settingsManager,
  };
}

function createSystemUpdateInput() {
  const fixture = createInput();
  const pinnedPrompt = "## Tools\nread, write";
  fixture.input.initialSystemPrompt = pinnedPrompt;
  fixture.activeSession.agent.state.messages = [toolResultMessage("read-1", "Read complete.")];
  const steer = fixture.queuePromptContext;
  const promptStateLease = retainEmbeddedSessionPromptState("permission-system-updates");
  onTestFinished(() => promptStateLease[Symbol.dispose]());
  const state = promptStateLease.state;
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
    const { agent } = fixture.activeSession;
    const snapshot = await agent.prepareNextTurn?.(signal);
    return snapshot?.prepareContinuation
      ? snapshot.prepareContinuation(snapshot.context ?? agent.state)
      : snapshot;
  };
  return {
    fixture,
    pinnedPrompt,
    steer,
    state,
    prepareSystemPromptUpdate,
    prepareNextRequest,
    prepare: (overrides: Partial<SessionInput> = {}) =>
      fixture.prepare({ prepareSystemPromptUpdate, ...overrides }),
    expectPublished: (prompt: string) => {
      expect(state.pendingSystemPrompt?.renderedPrefix).toBe(prompt);
      expect(steer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: expect.stringContaining(prompt) }),
      );
      expect(fixture.activeSession.agent.state.systemPrompt).toBe(pinnedPrompt);
    },
  };
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
  it("keeps effective workspace rules in automatic compaction when the process and sandbox cwd differ", async () => {
    const fixture = createInput();
    const workspaceDir = tempDirs.make("openclaw-attempt-compaction-workspace-");
    await writeFile(
      join(workspaceDir, "AGENTS.md"),
      "## Compaction fixture\nWORKSPACE_RULE_MARKER\n",
    );
    fixture.input.effectiveWorkspace = workspaceDir;
    fixture.input.effectiveCwd = "/sandbox";
    fixture.input.attempt = {
      ...fixture.input.attempt,
      model: createAnthropicModelFixture(),
      config: {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              postCompactionSections: ["Compaction fixture"],
              recentTurnsPreserve: 0,
              qualityGuard: { enabled: false },
            },
          },
        },
      },
    };
    const { buildEmbeddedExtensionFactories } =
      await vi.importActual<typeof import("../extensions.js")>("../extensions.js");
    hoisted.buildEmbeddedExtensionFactories.mockImplementation(buildEmbeddedExtensionFactories);
    safeguardTesting.setSummarizeCompactionHistoryForTest(async () => structuredSummary());
    try {
      await fixture.prepare();
      const { result } = await runCompactionScenario(
        fixture.input.sessionManager,
        createCompactionEvent(),
      );
      expect(expectCompactionResult(result).summary).toContain(
        "<workspace-critical-rules>\n## Compaction fixture\nWORKSPACE_RULE_MARKER\n</workspace-critical-rules>",
      );
    } finally {
      safeguardTesting.setSummarizeCompactionHistoryForTest();
    }
  });

  it("cancels a hydrated directory tool's approval with its captured permission generation", async () => {
    const fixture = createInput();
    const generation = new AbortController();
    fixture.input.clientToolPreparation = {
      codeModeControlsEnabledForRun: false,
      deferredDirectoryToolsCallable: true,
      getToolAbortSignal: () => generation.signal,
    } as never;
    await fixture.prepare();
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
      wrapToolWithAbortSignal({ ...createStubTool("mcp_write"), execute }, generation.signal),
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
      const check: Parameters<typeof withPromptFixture>[1] = async (promptFixture) => {
        const preparedPrompt = await promptFixture.prepare();
        const fixture = createInput();
        const source = promptFixture.attempt;
        const publishPrompt = vi.fn();
        const session = await fixture.prepare({
          attempt: {
            ...fixture.input.attempt,
            config: source.config,
            admittedRunContext: source.admittedRunContext,
            sessionId: source.sessionId,
            sessionKey: source.sessionKey,
            runId: source.runId,
            workspaceDir: source.workspaceDir,
            model: source.model,
            modelId: source.modelId,
            provider: source.provider,
            abortSignal: promptFixture.abort.signal,
          },
          initialSystemPrompt: preparedPrompt.systemPromptText,
          effectiveCwd: source.workspaceDir,
          sessionAgentId: "main",
          runAbortSignal: promptFixture.abort.signal,
          onSystemPromptChanged: publishPrompt,
        });
        const agent = fixture.activeSession.agent;
        const promptBefore = agent.state.systemPrompt;
        const report = preparedPrompt.systemPromptReport;
        assert(report, "Expected the actual prompt report");
        const reportBefore = structuredClone(report);
        publishPrompt.mockClear();
        const memory = gate();
        registerMemoryPromptPreparation("refresh-publication-fixture", async () => {
          await memory.wait();
          return ["## Late memory fixture", "Memory prepared for this permission refresh."];
        });
        let refresh: ReturnType<NonNullable<typeof preparedPrompt.prepareToolPrompt>> | undefined;
        const preparePermission = vi.fn(() => {
          assert(preparedPrompt.prepareToolPrompt, "Expected the real refreshable prompt owner");
          return (refresh = preparedPrompt.prepareToolPrompt(promptFixture.tools, {
            permissionChanged: true,
          }));
        });
        session.setPermissionPromptPreparation(preparePermission);
        const nextTurnSignal = new AbortController();
        assert(agent.prepareNextTurn, "Expected the registered session next-turn consumer");
        const nextTurn = Promise.resolve(agent.prepareNextTurn(nextTurnSignal.signal));
        const nextTurnSettled = Promise.allSettled([nextTurn]);
        try {
          await Promise.race([
            memory.entered,
            nextTurn.then(() => {
              throw new Error("Registered consumer finished before memory preparation");
            }),
          ]);
          if (lifetime === "closed") {
            promptFixture.admission.close();
          }
          expect(promptFixture.abort.signal.aborted).toBe(false);
          expect(nextTurnSignal.signal.aborted).toBe(false);
          memory.release();
          const [outcome] = await nextTurnSettled;
          await Promise.allSettled(refresh ? [refresh] : []);
          expect(preparePermission).toHaveBeenCalledTimes(1);
          if (lifetime === "closed") {
            expect({ prompt: agent.state.systemPrompt, report }).toEqual({
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
            expect(agent.state.systemPrompt).toContain("Late memory fixture");
            expect(agent.state.systemPrompt).not.toBe(promptBefore);
            expect(report.systemPrompt.hash).not.toBe(reportBefore.systemPrompt.hash);
            expect(report.systemPrompt.chars).toBe(agent.state.systemPrompt.length);
            expect(publishPrompt).toHaveBeenCalledTimes(1);
          }
        } finally {
          memory.release();
          await Promise.allSettled([nextTurn, ...(refresh ? [refresh] : [])]);
        }
      };
      await withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () =>
        withPromptFixture(
          {
            name: "disabled elevation",
            elevated: { enabled: false, allowed: false, defaultLevel: "off" },
            required: false,
          },
          check,
        ),
      );
    },
  );

  it("forwards whether permission guidance was freshly rendered", async () => {
    const { pinnedPrompt, prepareSystemPromptUpdate, prepareNextRequest, prepare } =
      createSystemUpdateInput();
    const prepared = await prepare();
    prepared.setPermissionPromptPreparation(async () => () => pinnedPrompt);
    const signal = new AbortController().signal;
    await prepareNextRequest(signal);
    expect(prepareSystemPromptUpdate).toHaveBeenLastCalledWith(pinnedPrompt, false);
    const currentPrompt = "## Tools\nread";
    prepared.setPermissionPromptPreparation(async () =>
      Object.assign(() => currentPrompt, { freshlyRendered: true }),
    );
    await prepareNextRequest(signal);
    expect(prepareSystemPromptUpdate).toHaveBeenLastCalledWith(currentPrompt, true);
  });

  it("keeps an initial update pending until replay admission succeeds", async () => {
    const f = createSystemUpdateInput();
    const { fixture, pinnedPrompt, steer, state } = f;
    const prepareReplay = vi
      .fn()
      .mockRejectedValueOnce(new Error("replay changed"))
      .mockResolvedValue(undefined);
    const prepared = await f.prepare({ prepareInitialUserTurnReplay: prepareReplay });
    prepared.setPermissionPromptPreparation(async () => () => "## Tools\nread");
    const prepare = fixture.setPromptPreparation.mock.lastCall?.[0];
    await expect(prepare!()).rejects.toThrow("replay changed");
    expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
    expect(steer).not.toHaveBeenCalled();

    const admit = await prepare!();
    expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
    expect(steer).not.toHaveBeenCalled();
    await admit?.((commit) => commit?.());
    f.expectPublished("## Tools\nread");
  });

  it.each(["replace", "abort"] as const)(
    "does not commit an awaited system update after %s",
    async (closure) => {
      const f = createSystemUpdateInput();
      const { fixture, pinnedPrompt, steer, state, prepareSystemPromptUpdate, prepareNextRequest } =
        f;
      const update = gate();
      const prepared = await fixture.prepare({
        prepareSystemPromptUpdate: async (prompt) => {
          const projection = prepareSystemPromptUpdate(prompt);
          await update.wait();
          return projection;
        },
      });
      prepared.setPermissionPromptPreparation(async () => () => "## Tools\nstale");
      const controller = new AbortController();
      const nextTurn = prepareNextRequest(controller.signal);
      const settled = Promise.allSettled([nextTurn]);
      await update.entered;
      if (closure === "abort") {
        controller.abort(new Error("run closed"));
      } else {
        prepared.setPermissionPromptPreparation(async () => () => "## Tools\nread");
      }
      update.release();
      const [result] = await settled;
      expect(fixture.activeSession.agent.state.systemPrompt).toBe(pinnedPrompt);
      if (closure === "abort") {
        expect(result).toMatchObject({ status: "rejected", reason: { message: "run closed" } });
        expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
        expect(steer).not.toHaveBeenCalled();
      } else {
        expect(result.status).toBe("fulfilled");
        f.expectPublished("## Tools\nread");
        expect(steer.mock.calls[0]?.[0].content).not.toContain("stale");
      }
    },
  );

  it("keeps updated permission tools and prompt when an older next-turn hook finishes later", async () => {
    const fixture = createInput();
    type Snapshot = Awaited<
      ReturnType<NonNullable<typeof fixture.activeSession.agent.prepareNextTurn>>
    >;
    const pending = createDeferredCore<Snapshot>();
    fixture.activeSession.agent.prepareNextTurn = () => pending.promise;
    const prepared = await fixture.prepare();
    const nextTurn = fixture.activeSession.agent.prepareNextTurn?.(new AbortController().signal);
    const readTool = createStubTool("read");
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

    const result = await fixture.prepare();

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "publish-system-prompt",
      "install-terminal-hook",
      "stage:agent-session",
    ]);
    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledOnce();
    const sessionCall = hoisted.createAgentSession.mock.calls[0];
    expect(sessionCall?.[0]).toMatchObject({
      resourceLoader: fixture.resourceLoader,
      tools: fixture.sessionToolAllowlist,
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "caller",
      cleanupProviderSessionResourcesOnDispose: false,
    });
    expect(fixture.activeSession.agent.state.systemPrompt).toBe("system prompt");
    expect(fixture.input.onSessionCreated).toHaveBeenCalledExactlyOnceWith(fixture.activeSession);
    expect(fixture.input.onSystemPromptChanged).toHaveBeenCalledWith("  system prompt\n");
    expect(result).toMatchObject({
      activeSession: fixture.activeSession,
      allCustomTools: fixture.allCustomTools,
      hookRunner: fixture.hookRunner,
      settingsManager: fixture.settingsManager,
      ...fixture.clientToolRuntime,
    });
    expect(result.hasDeliveredSourceReply()).toBe(false);
    fixture.onDeliveredSourceReply();
    expect(result.hasDeliveredSourceReply()).toBe(true);
  });

  it("refreshes replacement permissions while replay preparation waits", async () => {
    const fixture = createInput();
    const replay = gate<(onAdmitted: () => void) => Promise<void>>();
    const originalAdmission = vi.fn(async (onAdmitted: () => void) => onAdmitted());
    const currentAdmission = vi.fn(async (onAdmitted: () => void) => onAdmitted());
    const prepareReplay = vi
      .fn()
      .mockImplementationOnce(replay.wait)
      .mockResolvedValue(currentAdmission);
    const prepared = await fixture.prepare({ prepareInitialUserTurnReplay: prepareReplay });
    prepared.setPermissionPromptPreparation(async () => () => "old permissions");
    const preparation = fixture.setPromptPreparation.mock.lastCall?.[0];
    const pending = preparation!();
    await replay.entered;
    prepared.setPermissionPromptPreparation(async () => () => "current permissions");
    replay.release(originalAdmission);
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
      const prepared = await fixture.prepare();
      const pending = gate<(prompt: string) => string>();
      const staleRenderer = vi.fn(() => "stale permission prompt");
      prepared.setPermissionPromptPreparation(pending.wait);
      const controller = new AbortController();
      const nextTurn = fixture.activeSession.agent.prepareNextTurn!(controller.signal);
      const settled = Promise.allSettled([nextTurn]);
      await pending.entered;
      if (closure === "abort") {
        controller.abort();
      } else if (closure !== "current-error") {
        prepared.setPermissionPromptPreparation(async () => () => "current permission prompt");
      }
      if (closure === "replace-reject" || closure === "current-error") {
        pending.reject(new Error("obsolete memory preparation failed"));
      } else if (closure !== "replace-pending") {
        pending.release(staleRenderer);
      }
      const [result] = await settled;
      pending.release(staleRenderer);
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

  it.each(["before preparation", "before admission", "active"] as const)(
    "checks initial prompt and replay ownership: %s",
    async (phase) => {
      const fixture = createInput();
      const controller = new AbortController();
      const replay = vi.fn(async (onAdmitted: () => void) => onAdmitted());
      await fixture.prepare({
        runAbortSignal: controller.signal,
        prepareInitialUserTurnReplay:
          phase === "before preparation" ? undefined : async () => replay,
      });
      const prepare = fixture.setPromptPreparation.mock.lastCall?.[0];
      expect(prepare).toBeTypeOf("function");
      const reason = new Error("run closed during initial prompt admission");
      if (phase === "before preparation") {
        controller.abort(reason);
        await expect(prepare!()).rejects.toBe(reason);
        return;
      }
      const admit = await prepare!();
      expect(replay).not.toHaveBeenCalled();
      if (phase === "before admission") {
        controller.abort(reason);
      }
      const admitted = admit?.((commit) => commit?.());
      if (phase === "active") {
        await admitted;
        expect(replay).toHaveBeenCalledOnce();
      } else {
        await expect(admitted).rejects.toThrow(reason);
        expect(replay).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["abort", "replace"] as const)(
    "rechecks permission ownership inside awaited replay admission: %s",
    async (closure) => {
      const { fixture, pinnedPrompt, steer, state, prepare } = createSystemUpdateInput();
      const controller = new AbortController();
      const replay = gate();
      const prepared = await prepare({
        runAbortSignal: controller.signal,
        prepareInitialUserTurnReplay: async () => async (onAdmitted) => {
          await replay.wait();
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
      await replay.entered;
      expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
      if (closure === "abort") {
        controller.abort(new Error("run closed during replay admission"));
      } else if (closure === "replace") {
        prepared.setPermissionPromptPreparation(async () => () => "replacement permissions");
      }
      replay.release();
      const [result] = await settled;
      expect(result.status).toBe("rejected");
      expect(start).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      expect(state.pendingSystemPrompt?.renderedPrefix).toBe(pinnedPrompt);
    },
  );

  it("leaves overflow recovery with the session when no model budget was resolved", async () => {
    await createInput().prepare({ attempt: { ...attempt, contextTokenBudget: undefined } });
    expect(hoisted.createAgentSession.mock.calls[0]?.[0]).toMatchObject({
      beforeToolBatch: undefined,
      contextOverflowRecoveryOwner: "session",
    });
  });

  it("publishes session ownership before terminal-hook installation can fail", async () => {
    const fixture = createInput({ terminalHookError: new Error("terminal hook failed") });

    await expect(fixture.prepare()).rejects.toThrow("terminal hook failed");

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "publish-system-prompt",
      "install-terminal-hook",
    ]);
  });
});
