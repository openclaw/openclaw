import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
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
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { createQueuedAssistantStream } from "../../test-helpers/assistant-event-stream.test-support.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { formatToolExecutionGatedMessage } from "../../tool-policy-shared.js";
import { isToolResultError } from "../../tool-result-error.js";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import { createAgentsWaitTool } from "../../tools/agents-wait-tool.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { createAgentBackedAttemptSession } from "./attempt-agent.test-support.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

type AttemptOptions = Parameters<typeof createContextEngineAttemptRunner>[0];
type ToolOptions = NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
function runAttempt({
  sessionKey = "agent:main:main",
  createSession,
  ...attemptOverrides
}: NonNullable<AttemptOptions["attemptOverrides"]> & Pick<AttemptOptions, "createSession">) {
  return createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    tempPaths,
    sessionKey,
    createSession,
    attemptOverrides: { disableTools: false, ...attemptOverrides },
  });
}
function registerCleanup(tools = [createStubTool("read")]) {
  const cleanup = vi.fn(async (_reason: string) => {});
  hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
    const toolOptions = options as ToolOptions;
    toolOptions.registerRunCleanup?.(cleanup);
    return tools;
  });
  return cleanup;
}
function completedEvents(runId: string) {
  const events: { event: DiagnosticEventPayload; privateData: DiagnosticEventPrivateData }[] = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type === "run.completed" && event.runId === runId) {
      events.push({ event, privateData });
    }
  });
  return { events, unsubscribe };
}

describe("runEmbeddedAttempt tool boundaries", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    setRuntimeConfigSnapshot({});
    resetDiagnosticEventsForTest();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    vi.restoreAllMocks();
    clearRuntimeConfigSnapshot();
    resetDiagnosticEventsForTest();
  });

  it.each([
    ["direct spawn", "sessions_spawn", undefined, undefined],
    ["raw catalog wait", "agents_wait", 'return await agents_wait({ ids: ["child"] });', "bridge"],
    ["joined Code Mode", "sessions_spawn", 'return await agents.run("inspect");', "guest"],
  ] as const)(
    "does not enter the original preparer or action through denied %s",
    async (_mode, toolName, code, failurePhase) => {
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
      const call = {
        type: "toolCall" as const,
        id: "denied",
        name: code ? "exec" : toolName,
        arguments: code
          ? { title: "Inspect denied action", code }
          : toolName === "sessions_spawn"
            ? { task: "inspect" }
            : { ids: ["child"] },
      };
      await runAttempt({
        toolExecutionAllow: ["read"],
        sessionManager,
        config: { tools: { codeMode: Boolean(code), toolSearch: false } },
        createSession: () =>
          createAgentBackedAttemptSession((model, allTools) => {
            expect(allTools.map((tool) => tool.name)).toContain(code ? "exec" : toolName);
            let turn = 0;
            const agent = new Agent({
              initialState: { model, tools: allTools },
              // AgentSession's result middleware normally classifies structured tool failures.
              afterToolCall: async ({ result, isError }) => ({
                isError: isError || isToolResultError(result),
              }),
              streamFn: () => {
                const first = turn++ === 0;
                const message = makeAgentAssistantMessage({
                  content: first ? [call] : [{ type: "text", text: "Denied as expected." }],
                  api: model.api,
                  provider: model.provider,
                  model: model.id,
                  stopReason: first ? "toolUse" : "stop",
                });
                return createQueuedAssistantStream((push) => {
                  push({ type: "done", reason: first ? "toolUse" : "stop", message });
                });
              },
            });
            agent.subscribe((event) => {
              if (event.type === "tool_execution_end") {
                outcomes.push(event);
              }
            });
            return agent;
          }),
      });
      const outcome = outcomes.find((event) => event.toolName === (code ? "exec" : toolName));
      const denial = formatToolExecutionGatedMessage(toolName, ["read"]);
      const activities = sessionManager.getEntries().flatMap((entry) => {
        const activity = entry.type === "message" && readNestedToolActivity(entry.message);
        return activity ? [activity.details] : [];
      });
      if (failurePhase === "guest") {
        // Swarm globals are absent from the guest, so the script itself fails.
        expect(outcome).toMatchObject({
          isError: true,
          result: { details: { status: "failed", failurePhase, bridgeDispatchStarted: false } },
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
        const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
          | ToolOptions
          | undefined;
        catalogRef = expectDefined(options?.toolSearchCatalogRef, "attempt catalog");
        expect(catalogRef.current?.entries).toContainEqual(
          expect.objectContaining({ name: "cataloged_probe_tool" }),
        );
        if (cancel) {
          abortController.abort(diagnosticsError);
        } else {
          throw diagnosticsError;
        }
      });
      const cleanup = registerCleanup([
        createStubTool("tool_search"),
        createStubTool("cataloged_probe_tool"),
      ]);
      const { events, unsubscribe } = completedEvents(runId);

      const attempt = runAttempt({
        runId,
        abortSignal: abortController.signal,
        config: { tools },
        runtimePlan: {
          tools: {
            normalize: (normalizedTools: unknown[]) => normalizedTools,
            logDiagnostics,
          },
        } as never,
        sessionKey: "agent:main:telegram:direct:123",
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
        expect(events.map(({ event }) => event)).toContainEqual(
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
      await runAttempt({
        thinkLevel: "ultra",
        model: makeProviderModelFixture({
          id: "synthetic-model",
          provider,
          api: "openai-completions",
          baseUrl: "https://example.invalid/v1",
          reasoning: true,
          compat,
        }),
      });

      expect(hoisted.embeddedSystemPromptInputs.at(-1)).toMatchObject({
        proactiveSubagentOrchestration: true,
      });
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ requesterThinkingLevel: "ultra" }),
        [],
        undefined,
        undefined,
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
        thinkingLevel: expected ?? "off",
      });
      expect(hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5]).toBe(expected);
    },
  );

  it("attributes awaited bundle work separately from synchronous catalog preparation", async () => {
    const bundleLspTools = await import("../../agent-bundle-lsp-runtime.js");
    const runtimeToolPolicy = await import("../../runtime-plan/tools.js");
    const systemPromptReport = await import("../../system-prompt-report.js");
    const { buildSystemPromptReport } = await vi.importActual<typeof systemPromptReport>(
      "../../system-prompt-report.js",
    );
    vi.spyOn(systemPromptReport, "buildSystemPromptReport").mockImplementation(
      buildSystemPromptReport,
    );
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
    const attempt = runAttempt({
      config: { tools: { codeMode: true } },
      sessionKey: "agent:main:bundle-timing",
    });
    try {
      await awaitGateBeforeSettlement(
        acquired.promise,
        attempt,
        "Attempt completed before bundle acquisition",
      );
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
      for (const stage of [
        "bundle-tools:6000",
        "tool-catalog:37",
        "tool-preparation:6037",
        "system-prompt:0",
      ]) {
        expect(summary).toContain(`${stage}ms@`);
      }
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
      vi.spyOn(bundleLspTools, "createBundleLspToolRuntime").mockImplementationOnce(
        ({ abortSignal }) => {
          const onAbort = () => acquisition.reject(abortSignal?.reason);
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          if (abortSignal?.aborted) {
            onAbort();
          }
          acquired.resolve();
          return acquisition.promise.finally(() =>
            abortSignal?.removeEventListener("abort", onAbort),
          );
        },
      );
      const cleanup = registerCleanup();
      const runId = `run-lsp-acquisition-${kind}`;
      const { events: completed, unsubscribe } = completedEvents(runId);
      const attempt = runAttempt({
        runId,
        abortSignal: controller.signal,
        sessionKey: `agent:main:lsp-acquisition-${kind}`,
      });
      const outcome = attempt.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await awaitGateBeforeSettlement(
          acquired.promise,
          outcome,
          "Attempt completed before LSP acquisition",
        );
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
        expect(completed).toMatchObject([
          {
            event: {
              type: "run.completed",
              runId,
              outcome: "aborted",
              errorCategory: "Error",
            },
            privateData: { errorMessage: reason.message },
          },
        ]);
        expect(completed[0]?.event).not.toHaveProperty("error");
      } finally {
        // Missing signal forwarding must fail without stranding the attempt's owners.
        acquisition.reject(reason);
        try {
          await outcome;
          await waitForDiagnosticEventsDrained();
        } finally {
          unsubscribe();
        }
      }
    },
  );
});
