import { createAssistantMessageEventStream, type AssistantMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  onInternalDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
import { wrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import { Agent, type AgentEvent } from "../../runtime/index.js";
import { getInternalToolExecutionPreparer } from "../../runtime/internal-hooks.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { formatToolExecutionGatedMessage } from "../../tool-policy-shared.js";
import { isToolResultError } from "../../tool-result-error.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

function catalogProbeTools() {
  return [
    {
      name: "tool_search",
      description: "tool-search control surface",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
    {
      name: "cataloged_probe_tool",
      description: "deferred behind the catalog",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
  ];
}

function requireAttemptCatalogRef(): ToolSearchCatalogRef {
  const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
    | { toolSearchCatalogRef?: ToolSearchCatalogRef }
    | undefined;
  if (!options?.toolSearchCatalogRef) {
    throw new Error("Expected the embedded attempt to own its Tool Search catalog");
  }
  return options.toolSearchCatalogRef;
}

describe("runEmbeddedAttempt tool boundaries", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
  });

  it.each([
    { mode: "direct spawn", toolName: "sessions_spawn", code: undefined, failurePhase: undefined },
    {
      mode: "raw catalog wait",
      failurePhase: "bridge",
      toolName: "agents_wait",
      code: 'return await agents_wait({ ids: ["child"] });',
    },
    {
      mode: "joined Code Mode",
      failurePhase: "guest",
      toolName: "sessions_spawn",
      code: 'return await agents.run("inspect");',
    },
  ])(
    "does not enter the original preparer or action through denied $mode",
    async ({ toolName, code, failurePhase }) => {
      const sessionManager = SessionManager.inMemory();
      const execute = vi.fn(async () => ({ content: [], details: {} }));
      const prepare = vi.fn(async (args: unknown) => args);
      const native =
        toolName === "sessions_spawn"
          ? createSessionsSpawnTool({ agentSessionKey: "agent:main:main" })
          : createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
      native.execute = execute;
      native.prepareBeforeToolCallParams = prepare;
      const source = wrapToolWithBeforeToolCallHook(native);
      expect(getInternalToolExecutionPreparer(source)).toBeDefined();
      hoisted.createOpenClawCodingToolsMock.mockReturnValue([source]);
      const outcomes: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:main",
        tempPaths,
        createSession: () => {
          const session = createDefaultEmbeddedSession();
          const options = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0];
          if (!options?.customTools) {
            throw new Error("Expected the embedded attempt to supply custom tools");
          }
          const allTools = options.customTools.map((definition) => wrapToolDefinition(definition));
          expect(allTools.map((tool) => tool.name)).toContain(code ? "exec" : toolName);
          let turn = 0;
          const agent = new Agent({
            initialState: { model: options.model, tools: allTools },
            // AgentSession's result middleware normally classifies structured tool failures.
            afterToolCall: async ({ result, isError }) => ({
              isError: isError || isToolResultError(result),
            }),
            streamFn: () => {
              const content: AssistantMessage["content"] =
                turn++ === 0
                  ? [
                      {
                        type: "toolCall",
                        id: "denied",
                        name: code ? "exec" : toolName,
                        arguments: code
                          ? { title: "Inspect the denied catalog action", code }
                          : toolName === "sessions_spawn"
                            ? { task: "inspect" }
                            : { ids: ["child"] },
                      },
                    ]
                  : [{ type: "text", text: "Denied as expected." }];
              const message: AssistantMessage = {
                role: "assistant",
                content,
                api: options.model.api,
                provider: options.model.provider,
                model: options.model.id,
                usage: createZeroUsageFixture(),
                stopReason: turn === 1 ? "toolUse" : "stop",
                timestamp: Date.now(),
              };
              const stream = createAssistantMessageEventStream();
              queueMicrotask(() => {
                stream.push({ type: "done", reason: turn === 1 ? "toolUse" : "stop", message });
                stream.end();
              });
              return stream;
            },
          });
          agent.subscribe((event) => {
            if (event.type === "tool_execution_end") {
              outcomes.push(event);
            }
          });
          // SAFETY: This session fixture delegates its agent operations to the real loop below.
          session.agent = agent as typeof session.agent;
          Object.defineProperty(session, "messages", {
            get: () => agent.state.messages,
            set: (messages) => {
              agent.state.messages = messages;
            },
          });
          session.setActiveToolsByName = (names) => {
            agent.state.tools = allTools.filter((tool) => names.includes(tool.name));
          };
          session.getActiveToolNames = () => agent.state.tools.map((tool) => tool.name);
          session.prompt = async (prompt, opts) => {
            opts?.preflightResult?.(true);
            await agent.prompt(prompt);
          };
          return session;
        },
        attemptOverrides: {
          disableTools: false,
          toolExecutionAllow: ["read"],
          sessionManager,
          config: { tools: { codeMode: Boolean(code), toolSearch: false } },
        },
      });
      const outcome = outcomes.find((event) => event.toolName === (code ? "exec" : toolName));
      const denial = formatToolExecutionGatedMessage(toolName, ["read"]);
      const activities = sessionManager.getEntries().flatMap((entry) => {
        const activity = entry.type === "message" && readNestedToolActivity(entry.message);
        return activity ? [activity.details] : [];
      });
      if (failurePhase === "guest") {
        // Swarm globals are absent from the guest, so the script itself fails.
        expect(outcome).toMatchObject({ isError: true });
        expect(outcome?.result).toMatchObject({
          details: { status: "failed", failurePhase, bridgeDispatchStarted: false },
        });
        expect(activities).toEqual([]);
      } else if (code) {
        // Code Mode dispatched the call, which reached only the gated stand-in.
        expect(activities).toEqual([expect.objectContaining({ toolName })]);
      } else {
        expect(outcome).toMatchObject({
          isError: false,
          result: { content: [expect.objectContaining({ text: denial })] },
        });
        expect(activities).toEqual([]);
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["tool-search-directory", { toolSearch: { enabled: true, mode: "directory" } }, false, false],
    ["timed-out-code-mode", { codeMode: { enabled: true } }, true, true],
  ] as const)(
    "clears the %s run catalog when preparation fails or is cancelled",
    async (mode, tools, cancel, timeout) => {
      const runId = `run-catalog-diagnostics-${mode}`;
      const diagnosticsError = new Error(`failed ${mode} tool diagnostics`);
      if (timeout) {
        diagnosticsError.name = "TimeoutError";
      }
      const abortController = new AbortController();
      let catalogRef: ToolSearchCatalogRef | undefined;
      const logDiagnostics = vi.fn(() => {
        catalogRef = requireAttemptCatalogRef();
        expect(catalogRef.current?.entries).toContainEqual(
          expect.objectContaining({ name: "cataloged_probe_tool" }),
        );
        if (cancel) {
          abortController.abort(diagnosticsError);
        } else {
          throw diagnosticsError;
        }
      });
      const cleanup = vi.fn(async (_reason: string) => {});
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
        const toolOptions = options as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
        toolOptions.registerRunCleanup?.(cleanup);
        return catalogProbeTools();
      });
      const events: DiagnosticEventPayload[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => events.push(event), {
        include: ["run.completed"],
      });

      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:telegram:direct:123",
        tempPaths,
        attemptOverrides: {
          runId,
          abortSignal: abortController.signal,
          disableTools: false,
          config: { tools },
          runtimePlan: {
            tools: {
              normalize: (normalizedTools: unknown[]) => normalizedTools,
              logDiagnostics,
            },
          } as never,
        },
      });

      try {
        if (timeout) {
          await expect(attempt).rejects.toMatchObject({
            cause: diagnosticsError,
            terminalOutcome: { status: "timeout" },
          });
        } else {
          await expect(attempt).rejects.toBe(diagnosticsError);
        }
      } finally {
        unsubscribe();
      }
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(
        timeout ? "timeout" : cancel ? "cancel" : "completion",
      );
      if (timeout) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "run.completed",
            runId,
            outcome: "aborted",
          }),
        );
      }
      expect(logDiagnostics).toHaveBeenCalledOnce();
      expect(catalogRef).toBeDefined();
      expect(catalogRef?.current).toBeUndefined();
    },
  );

  it.each([
    { provider: "custom", expected: "high", compat: undefined },
    { provider: "openai", expected: undefined, compat: { supportsReasoningEffort: false } },
  ])(
    "keeps Ultra logical at $provider effort boundaries",
    async ({ provider, expected, compat }) => {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:main",
        tempPaths,
        attemptOverrides: {
          disableTools: false,
          thinkLevel: "ultra",
          model: {
            id: "synthetic-model",
            provider,
            name: "Synthetic model",
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            reasoning: true,
            compat,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      });

      const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
        proactiveSubagentOrchestration?: boolean;
      };
      const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        thinkingLevel?: string;
      };
      const providerThinkingLevel = hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5];

      expect(promptInput.proactiveSubagentOrchestration).toBe(true);
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ requesterThinkingLevel: "ultra" }),
        [],
        undefined,
        undefined,
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(sessionOptions.thinkingLevel).toBe(expected ?? "off");
      expect(providerThinkingLevel).toBe(expected);
    },
  );

  describe("preparation diagnostics", () => {
    beforeEach(resetDiagnosticEventsForTest);
    afterEach(resetDiagnosticEventsForTest);

    it("attributes awaited bundle work separately from synchronous catalog preparation", async () => {
      const bundleLspTools = await import("../../agent-bundle-lsp-runtime.js");
      const runtimeToolPolicy = await import("../../runtime-plan/tools.js");
      const { log } = await import("../logger.js");
      let clock = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      const warn = vi.spyOn(log, "warn");
      const acquired = createDeferred();
      const release = createDeferred();
      const dispose = vi.fn(async () => {});
      vi.spyOn(bundleLspTools, "createBundleLspToolRuntime").mockImplementationOnce(async () => {
        acquired.resolve();
        await release.promise;
        return { tools: [], sessions: [], dispose };
      });
      vi.spyOn(runtimeToolPolicy, "logAgentRuntimeToolDiagnostics").mockImplementation(() => {
        clock += 37;
      });
      getHoisted().createOpenClawCodingToolsMock.mockReturnValue([createStubTool("read")]);
      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:bundle-timing",
        tempPaths,
        attemptOverrides: {
          disableTools: false,
          config: { tools: { codeMode: true } },
        },
      });
      try {
        await Promise.race([
          acquired.promise,
          attempt.then(() => {
            throw new Error("Attempt completed before bundle acquisition");
          }),
        ]);
        clock += 6_000;
        release.resolve();
        const result = await attempt;
        expect(result.terminal).toEqual({ kind: "ok" });
        expect(dispose).toHaveBeenCalledOnce();
        const summary = warn.mock.calls
          .map(([message]) => message)
          .find(
            (message) => message.includes("prep stages:") && message.includes("phase=stream-ready"),
          );
        expect(summary).toContain("bundle-tools:6000ms@");
        expect(summary).toContain("tool-catalog:37ms@");
        expect(summary).toContain("tool-preparation:6037ms@");
        expect(summary).toContain("system-prompt:0ms@");
      } finally {
        release.resolve();
        await attempt;
      }
    });

    it.each([
      { kind: "cancel", errorName: "AbortError" },
      { kind: "timeout", errorName: "TimeoutError" },
    ] as const)(
      "classifies $kind during pending LSP acquisition through the full attempt",
      async ({ kind, errorName }) => {
        const bundleLspTools = await import("../../agent-bundle-lsp-runtime.js");
        const acquired = createDeferred();
        const acquisition = createDeferred<never>();
        void acquisition.promise.catch(() => {});
        const controller = new AbortController();
        const reason = new Error(`LSP preparation ${kind}`);
        reason.name = errorName;
        const createLsp = vi
          .spyOn(bundleLspTools, "createBundleLspToolRuntime")
          .mockImplementationOnce(({ abortSignal }) => {
            const onAbort = () => acquisition.reject(abortSignal?.reason);
            abortSignal?.addEventListener("abort", onAbort, { once: true });
            if (abortSignal?.aborted) {
              onAbort();
            }
            acquired.resolve();
            return acquisition.promise.finally(() =>
              abortSignal?.removeEventListener("abort", onAbort),
            );
          });
        const cleanup = vi.fn(async (_reason: string) => {});
        hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
          const toolOptions = options as NonNullable<
            Parameters<typeof createOpenClawCodingTools>[0]
          >;
          toolOptions.registerRunCleanup?.(cleanup);
          return [createStubTool("read")];
        });
        const runId = `run-lsp-acquisition-${kind}`;
        const completed: Array<{
          event: DiagnosticEventPayload;
          privateData: DiagnosticEventPrivateData;
        }> = [];
        const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
          if (event.type === "run.completed" && event.runId === runId) {
            completed.push({ event, privateData });
          }
        });
        const attempt = createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: `agent:main:lsp-acquisition-${kind}`,
          tempPaths,
          attemptOverrides: { runId, abortSignal: controller.signal, disableTools: false },
        });
        const outcome = attempt.then(
          () => undefined,
          (error: unknown) => error,
        );
        try {
          await Promise.race([
            acquired.promise,
            outcome.then(() => {
              throw new Error("Attempt completed before LSP acquisition");
            }),
          ]);
          controller.abort(reason);
          await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), { timeout: 1_000 });
          expect(cleanup).toHaveBeenCalledExactlyOnceWith(kind);
          const error = await outcome;
          if (kind === "timeout") {
            if (!(error instanceof AgentRunTerminalOutcomeError)) {
              throw new Error("Expected the canonical timeout outcome", { cause: error });
            }
            expect(error.cause).toBe(reason);
            expect(error.terminalOutcome).toMatchObject({ status: "timeout" });
          } else {
            expect(error).toBe(reason);
          }
          expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
          await waitForDiagnosticEventsDrained();
          expect(completed).toHaveLength(1);
          expect(completed[0]?.event).toMatchObject({
            type: "run.completed",
            runId,
            outcome: "aborted",
            errorCategory: "Error",
          });
          expect(completed[0]?.event).not.toHaveProperty("error");
          expect(completed[0]?.privateData.errorMessage).toBe(reason.message);
        } finally {
          // Missing signal forwarding must fail without stranding the attempt's owners.
          acquisition.reject(reason);
          try {
            await outcome;
            await waitForDiagnosticEventsDrained();
          } finally {
            unsubscribe();
            createLsp.mockRestore();
          }
        }
      },
    );
  });
});
