import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  onAgentRuntimeEvent,
  rotateAgentEventLifecycleGeneration,
  type AgentEventRuntimePayload,
} from "../../infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import {
  closeAdmittedRunDelegatedAuthority,
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import type { CliToolUseStartDelta } from "../cli-output-contracts.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { createCliEventHandlers, type CliEventHandlers } from "./execute-events.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

const toolStart: CliToolUseStartDelta = {
  toolCallId: "accepted-tool",
  name: "read",
  kind: "tool_use",
  args: { path: "note.txt" },
};
const toolResult = {
  toolCallId: toolStart.toolCallId,
  name: toolStart.name,
  isError: false,
  result: "contents",
};

async function createFixture(executionMode?: "side-question", admitted = true) {
  const runId = "cli-event-authority";
  const context = buildPreparedCliRunContext({
    runId,
    sessionId: "event-session",
    sessionKey: "agent:main:event-session",
    agentId: "main",
    executionMode,
  });
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "cli-event-test");
  onTestFinished(admission.close);
  context.params.admittedRunContext = admitted
    ? await admission.admit("embedded")
    : createTestAdmittedRunContext(runId);
  const controller = new AbortController();
  const assertCurrent = vi.fn();
  const onExecutionPhase = vi.fn();
  context.params.abortSignal = controller.signal;
  context.params.assertCurrent = assertCurrent;
  context.params.onExecutionPhase = onExecutionPhase;
  const tracking = createCliToolTracking(context);
  const start = vi.spyOn(tracking, "handleCliToolUseStart");
  const result = vi.spyOn(tracking, "handleCliToolResult");
  const outcome = vi.spyOn(tracking, "resolveCliLoopbackTerminalOutcome");
  const getRunState = vi.fn((): { failed: boolean; error: unknown } => ({
    failed: false,
    error: undefined,
  }));
  const events: AgentEventRuntimePayload[] = [];
  const diagnostics: TrustedToolExecutionEvent[] = [];
  onTestFinished(onAgentRuntimeEvent((event) => events.push(event)));
  onTestFinished(onTrustedToolExecutionEvent((event) => diagnostics.push(event)));
  const inputs: Parameters<typeof createCliEventHandlers>[0] = {
    context,
    toolTracking: tracking,
    getRunState,
  };
  const handlers = createCliEventHandlers(inputs);
  return {
    inputs,
    tracking,
    context,
    admission,
    controller,
    assertCurrent,
    onExecutionPhase,
    start,
    result,
    outcome,
    getRunState,
    events,
    diagnostics,
    handlers,
  };
}

function emitEveryInput(handlers: CliEventHandlers) {
  handlers.emitCliAssistantDelta({ text: "answer", delta: "answer" });
  handlers.emitCliThinkingDelta({ text: "reasoning", delta: "reasoning" });
  handlers.emitCliThinkingProgress({ progressTokens: 8 });
  handlers.emitCliCommentaryText("checking");
  handlers.emitCliCompaction({ phase: "start" });
  handlers.emitCliToolUseStart(toolStart);
  handlers.emitCliToolResult(toolResult);
  handlers.emitCliDisplayToolUseStart({ ...toolStart, toolCallId: "display-tool" });
  handlers.emitCliDisplayToolResult({ ...toolResult, toolCallId: "display-tool" });
  handlers.emitParsedToolUseStart({ ...toolStart, toolCallId: "parsed-tool" });
  handlers.emitParsedToolResult({ ...toolResult, toolCallId: "parsed-tool" });
}

describe("CLI event handler admitted ownership", () => {
  it("publishes every live stream with its exact private admitted root claim", async () => {
    const fixture = await createFixture();
    const root = getAdmittedRunDelegatedAuthority(fixture.context.params.admittedRunContext);
    expect(root).toBeDefined();
    emitEveryInput(fixture.handlers);

    expect(fixture.events).toHaveLength(11);
    for (const [index, event] of fixture.events.entries()) {
      expect(event).toMatchObject({
        runId: fixture.context.params.runId,
        contextClaimId: root?.claimId,
        lifecycleGeneration: root?.lifecycleGeneration,
        seq: index + 1,
      });
      expect(Object.keys(event)).not.toContain("contextClaimId");
      expect(Object.keys(event)).not.toContain("lifecycleGeneration");
    }
  });

  it.each(["closed", "aborted", "replaced", "rotated", "caller-retired", "unadmitted"] as const)(
    "rejects every incoming handler before effects when %s",
    async (reason) => {
      const fixture = await createFixture(undefined, reason !== "unadmitted");
      if (reason === "closed") {
        fixture.admission.close();
      } else if (reason === "aborted") {
        fixture.controller.abort();
      } else if (reason === "replaced") {
        const successor = prepareSystemAgentRunAdmission(
          {},
          fixture.context.params.runId,
          "main",
          "cli-event-successor",
        );
        onTestFinished(successor.close);
        fixture.context.params.admittedRunContext = await successor.admit("embedded");
      } else if (reason === "rotated") {
        rotateAgentEventLifecycleGeneration();
      } else if (reason === "caller-retired") {
        fixture.assertCurrent.mockImplementation(() => {
          throw new Error("attempt retired");
        });
      }

      emitEveryInput(fixture.handlers);

      expect(fixture.events).toEqual([]);
      expect(fixture.diagnostics).toEqual([]);
      expect(fixture.start).not.toHaveBeenCalled();
      expect(fixture.result).not.toHaveBeenCalled();
      expect(fixture.outcome).not.toHaveBeenCalled();
      expect(fixture.getRunState).not.toHaveBeenCalled();
      expect(fixture.onExecutionPhase).not.toHaveBeenCalled();
      expect(fixture.handlers.hasObservedCliActivity()).toBe(false);
      expect(fixture.handlers.activeParsedToolCount()).toBe(0);
      expect(fixture.handlers.getToolSummary()).toEqual({ calls: 0, tools: [], failures: 0 });
    },
  );

  it("keeps captured routing, callbacks, and cancellation when the input object is reused", async () => {
    const fixture = await createFixture();
    const original = { ...fixture.context.params };
    const root = getAdmittedRunDelegatedAuthority(original.admittedRunContext);
    const replacementPhase = vi.fn();
    Object.assign(fixture.context.params, {
      runId: "other-run",
      sessionId: "other-session",
      sessionKey: "agent:other:session",
      agentId: "other",
      provider: "other-provider",
      onExecutionPhase: replacementPhase,
      assertCurrent: () => {
        throw new Error("replacement callback must not be read");
      },
      abortSignal: new AbortController().signal,
    });
    fixture.context.modelId = "other-model";
    fixture.context.backendResolved.id = "other-backend";
    const replacementCallback = vi.fn(() => {
      throw new Error("replacement callback must not be read");
    });
    fixture.tracking.handleCliToolUseStart = replacementCallback;
    fixture.tracking.handleCliToolResult = replacementCallback;
    fixture.tracking.resolveCliLoopbackTerminalOutcome = replacementCallback;
    fixture.inputs.getRunState = replacementCallback;
    fixture.handlers.emitParsedToolUseStart(toolStart);
    fixture.handlers.emitParsedToolResult(toolResult);

    expect(fixture.events).toHaveLength(2);
    expect(fixture.events.every((event) => event.contextClaimId === root?.claimId)).toBe(true);
    expect(fixture.events.every((event) => event.runId === original.runId)).toBe(true);
    expect(fixture.diagnostics).toMatchObject([
      {
        type: "tool.execution.started",
        runId: original.runId,
        sessionId: original.sessionId,
        sessionKey: original.sessionKey,
        agentId: original.agentId,
      },
      { type: "tool.execution.completed", runId: original.runId },
    ]);
    expect(fixture.onExecutionPhase).toHaveBeenCalledWith({
      phase: "tool_execution_started",
      provider: "claude-cli",
      model: "sonnet",
      backend: "claude-cli",
    });
    expect(replacementPhase).not.toHaveBeenCalled();
    expect(replacementCallback).not.toHaveBeenCalled();
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.result).toHaveBeenCalledOnce();
    expect(fixture.getRunState).toHaveBeenCalledOnce();
    fixture.controller.abort();
    fixture.handlers.emitCliThinkingProgress({ progressTokens: 99 });
    expect(fixture.events).toHaveLength(2);
  });

  it.each([
    "assertion",
    "phase",
    "tracking-start",
    "tracking-result",
    "diagnostic-start",
    "diagnostic-terminal",
    "outcome",
    "run-state",
  ] as const)("rechecks closure after reentrant %s callbacks", async (boundary) => {
    const fixture = await createFixture();
    const terminal =
      boundary === "diagnostic-terminal" || boundary === "outcome" || boundary === "run-state";
    if (terminal) {
      fixture.handlers.emitParsedToolUseStart(toolStart);
      fixture.events.length = 0;
      fixture.diagnostics.length = 0;
      fixture.start.mockClear();
      fixture.onExecutionPhase.mockClear();
    }
    const abort = () => fixture.controller.abort();
    if (boundary === "assertion") {
      fixture.assertCurrent.mockImplementation(abort);
    } else if (boundary === "phase") {
      fixture.onExecutionPhase.mockImplementation(abort);
    } else if (boundary === "tracking-start") {
      fixture.start.mockImplementation(abort);
    } else if (boundary === "tracking-result") {
      fixture.result.mockImplementation(abort);
    } else if (boundary === "outcome") {
      fixture.outcome.mockImplementation(() => {
        abort();
        return undefined;
      });
    } else if (boundary === "run-state") {
      fixture.getRunState.mockImplementation(() => {
        abort();
        return { failed: false, error: undefined };
      });
    } else {
      onTestFinished(onTrustedToolExecutionEvent(abort));
    }

    if (terminal) {
      fixture.handlers.emitParsedToolResult(toolResult);
    } else if (boundary === "diagnostic-start") {
      fixture.handlers.emitParsedToolUseStart(toolStart);
    } else if (boundary === "tracking-result") {
      fixture.handlers.emitCliToolResult(toolResult);
    } else {
      fixture.handlers.emitCliToolUseStart(toolStart);
    }

    expect(fixture.controller.signal.aborted).toBe(true);
    expect(fixture.events).toEqual([]);
    if (boundary !== "tracking-start") {
      expect(fixture.start).not.toHaveBeenCalled();
    }
    if (boundary !== "tracking-result") {
      expect(fixture.result).not.toHaveBeenCalled();
    }
    expect(fixture.diagnostics).toHaveLength(boundary.startsWith("diagnostic-") ? 1 : 0);
    if (boundary === "outcome") {
      expect(fixture.getRunState).not.toHaveBeenCalled();
    }
    if (boundary === "assertion") {
      expect(fixture.onExecutionPhase).not.toHaveBeenCalled();
      expect(fixture.handlers.hasObservedCliActivity()).toBe(false);
      expect(fixture.handlers.getToolSummary().calls).toBe(0);
    }
  });

  it("settles only previously accepted parsed tools after abort without inventing server outcomes", async () => {
    const fixture = await createFixture();
    fixture.handlers.emitParsedToolUseStart(toolStart);
    fixture.handlers.emitParsedToolUseStart({
      ...toolStart,
      toolCallId: "server-tool",
      kind: "server_tool_use",
    });
    const acceptedEvents = fixture.events.slice();
    fixture.controller.abort();
    closeAdmittedRunDelegatedAuthority(fixture.context.params.admittedRunContext);
    fixture.getRunState.mockReturnValue({
      failed: true,
      error: Object.assign(new Error("cancelled"), { name: "AbortError" }),
    });

    fixture.handlers.emitParsedToolResult(toolResult);
    expect(fixture.handlers.activeParsedToolCount()).toBe(2);
    fixture.handlers.finalizeParsedTools();
    fixture.handlers.finalizeParsedTools();

    expect(fixture.events).toEqual(acceptedEvents);
    expect(fixture.result).not.toHaveBeenCalled();
    expect(fixture.handlers.activeParsedToolCount()).toBe(0);
    expect(fixture.diagnostics).toMatchObject([
      { type: "tool.execution.started", toolCallId: toolStart.toolCallId },
      { type: "tool.execution.started", toolCallId: "server-tool" },
      {
        type: "tool.execution.error",
        toolCallId: toolStart.toolCallId,
        terminalReason: "cancelled",
      },
      {
        type: "tool.execution.error",
        toolCallId: "server-tool",
        errorCode: "tool_outcome_unknown",
      },
    ]);
    expect(fixture.diagnostics[3]).not.toHaveProperty("terminalReason");
  });

  it("keeps side questions nonlive while recording accepted tool summaries", async () => {
    const fixture = await createFixture("side-question");
    emitEveryInput(fixture.handlers);
    expect(fixture.events).toEqual([]);
    expect(fixture.start).toHaveBeenCalledTimes(2);
    expect(fixture.result).toHaveBeenCalledTimes(2);
    expect(fixture.diagnostics).toHaveLength(2);
    expect(fixture.handlers.getToolSummary()).toEqual({
      calls: 3,
      tools: ["read"],
      failures: 0,
    });
  });
});
