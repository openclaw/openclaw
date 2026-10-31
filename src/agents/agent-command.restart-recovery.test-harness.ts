import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Mock } from "vitest";
import { expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, type ReplyPayload } from "../auto-reply/reply-payload.js";
import { mirrorDeliveredReplyToTranscript } from "../auto-reply/reply/dispatch-from-config.transcript.js";
import type { SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { loadSessionCostSummary } from "../infra/session-cost-usage.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { agentCommand } from "./agent-command.js";
import type { CommandSessionEntryFixture } from "./agent-command.live-model-switch.test-helpers.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { buildCliRunResult } from "./cli-runner/cli-run-settlement.js";
import { prepareCliRunTerminalReply } from "./cli-runner/terminal-reply.js";
import { resolveEmbeddedRunTerminal } from "./embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "./embedded-agent-runner/run/terminal-resolution.test-support.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

type AgentCommandRecoveryFixture = {
  state: {
    runAgentAttemptMock: Mock;
    persistCliTurnTranscriptMock: Mock;
    resolveAgentDeliveryPlanWithSessionRouteMock: Mock;
    commandWarnMock: Mock;
    emitAgentEventMock: Mock;
    deliverAgentCommandResultMock: Mock;
    persistSessionEntryMock: Mock<(...args: unknown[]) => Promise<unknown>>;
    loadSessionEntryMock: Mock;
    resolvedSessionKeyMock?: string;
  };
  agentCommand: typeof agentCommand;
  setupSingleAttemptFallback: () => void;
  setupBareStoredSession: (
    overrides?: CommandSessionEntryFixture,
    storePath?: string,
    sessionKey?: string,
  ) => { entry: SessionEntry; store: Record<string, SessionEntry> };
  makeSuccessResult: (provider: string, model: string) => unknown;
};

export async function withStoredAgentCommandRecoverySession(
  fixture: AgentCommandRecoveryFixture,
  run: (scope: { agentId: string; sessionKey: string; storePath: string }) => Promise<void>,
  overrides: CommandSessionEntryFixture = {},
): Promise<void> {
  await withOpenClawTestState({ label: "command-recovery-delivery" }, async (testState) => {
    const scope = {
      agentId: "default",
      sessionKey: "agent:default:main",
      storePath: path.join(testState.sessionsDir("default"), "sessions.json"),
    };
    const { entry } = fixture.setupBareStoredSession(overrides, scope.storePath, scope.sessionKey);
    fixture.state.resolvedSessionKeyMock = scope.sessionKey;
    await sessionAccessor.replaceSessionEntry(scope, entry);
    const { persistAgentSession: persist } = await vi.importActual<
      typeof import("./command/attempt-execution.shared.js")
    >("./command/attempt-execution.shared.js");
    fixture.state.persistSessionEntryMock.mockImplementation(async (...args: unknown[]) =>
      persist(args[0] as Parameters<typeof persist>[0]),
    );
    fixture.state.loadSessionEntryMock.mockImplementation(sessionAccessor.loadSessionEntry);
    await run(scope);
  });
}

export function registerAgentCommandRecoveryCases(
  getFixture: () => AgentCommandRecoveryFixture,
): void {
  it("keeps CLI progress mirrors out of the fallback assistant transcript", async () => {
    const fixture = getFixture();
    const { state, agentCommand, setupSingleAttemptFallback } = fixture;
    const requireRecord = createRequireRecord("object", "expected-label-object");
    await withStoredAgentCommandRecoverySession(fixture, async (scope) => {
      setupSingleAttemptFallback();
      const entry = expectDefined(sessionAccessor.loadSessionEntry(scope), "stored CLI session");
      const context = buildPreparedCliRunContext({
        ...scope,
        sessionId: entry.sessionId,
        runId: "cli-progress-mirror-run",
      });
      context.params.sourceReplyDeliveryMode = "message_tool_only";
      context.params.terminalReplyExpectation = "optional";
      const output = {
        text: "private terminal confirmation",
        usage: { input: 2, output: 3, cacheRead: 10, total: 15 },
        diagnosticUsage: { input: 20, output: 30, cacheRead: 100, total: 150 },
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messagingToolSourceReplyPayloads: [
          { text: "First progress update", sourceReplyFinal: false },
          { text: "Second progress update", sourceReplyFinal: false },
        ],
      };
      const result = buildCliRunResult({
        context,
        output,
        preparedReply: prepareCliRunTerminalReply(context, output),
        bindingFlushOk: true,
        usedHistoryPrompt: false,
        userTurnHandled: true,
        sessionBindingDisabled: false,
        preparedContextAgentMeta: {},
      });
      state.runAgentAttemptMock.mockResolvedValue(result);
      const transcript = await vi.importActual<
        typeof import("./command/transcript-persistence.js")
      >("./command/transcript-persistence.js");
      let persistedParams: Parameters<typeof transcript.persistCliTurnTranscript>[0] | undefined;
      state.persistCliTurnTranscriptMock.mockImplementation(async (params) => {
        persistedParams = params;
        return transcript.persistCliTurnTranscript(params);
      });
      state.deliverAgentCommandResultMock.mockImplementation(async () => {
        for (const payload of result.payloads ?? []) {
          const mirror = expectDefined(
            getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror,
            "CLI source reply mirror",
          );
          await mirrorDeliveredReplyToTranscript({
            metadata: { ...mirror, storePath: scope.storePath, expectedSessionId: entry.sessionId },
            cfg: {},
          });
        }
        return { deliverySucceeded: true };
      });
      await agentCommand({ message: "hello", to: "+1234567890", sessionKey: scope.sessionKey });
      // Replaying the same turn must not count its usage twice.
      await transcript.persistCliTurnTranscript(
        expectDefined(persistedParams, "CLI turn parameters"),
      );
      const events = await sessionAccessor.loadTranscriptEvents({
        ...scope,
        sessionId: entry.sessionId,
      });
      const assistants = events
        .map((event) => requireRecord(event, "transcript event"))
        .filter((event) => event.type === "message")
        .map((event) => requireRecord(event.message, "transcript message"))
        .filter((message) => message.role === "assistant");
      expect(
        assistants.filter((message) => message.display !== false).map((message) => message.content),
      ).toEqual([
        [{ type: "text", text: "First progress update" }],
        [{ type: "text", text: "Second progress update" }],
      ]);
      expect(assistants.filter((message) => message.display === false)).toMatchObject([
        {
          content: [],
          usage: {
            input: 20,
            output: 30,
            cacheRead: 100,
            totalTokens: 150,
            contextUsage: { state: "available", promptTokens: 12, totalTokens: 15 },
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("private terminal confirmation");
      const usage = await loadSessionCostSummary({
        agentId: scope.agentId,
        sessionId: entry.sessionId,
        sessionTarget: { ...scope, sessionId: entry.sessionId },
        config: {},
      });
      expect(usage).toMatchObject({ input: 20, output: 30, cacheRead: 100, totalTokens: 150 });
    });
  });

  it("preserves bounded delivery evidence when strict post-turn delivery throws", async () => {
    const fixture = getFixture();
    const { state, agentCommand, setupSingleAttemptFallback, makeSuccessResult } = fixture;
    await withStoredAgentCommandRecoverySession(fixture, async (scope) => {
      setupSingleAttemptFallback();
      state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
      const secret = ["sk", "strict-delivery-secret-value"].join("-");
      state.deliverAgentCommandResultMock.mockImplementation(async (params: unknown) => {
        (
          params as {
            onDeliveryResult?: (
              result: { deliveryStatus: Record<string, unknown> },
              payloads: ReplyPayload[],
            ) => void;
          }
        ).onDeliveryResult?.(
          {
            deliveryStatus: {
              status: "failed",
              errorMessage: `Authorization: Bearer ${secret}`,
              target: "discord:dm:private",
            },
          },
          [],
        );
        throw new Error("strict delivery failed");
      });
      await expect(
        agentCommand({
          message: "hello",
          sessionKey: scope.sessionKey,
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          deliver: true,
        }),
      ).rejects.toThrow("strict delivery failed");

      const lifecycleError = state.emitAgentEventMock.mock.calls
        .map((call) => call[0] as { stream?: string; data?: Record<string, unknown> })
        .find((event) => event.stream === "lifecycle" && event.data?.phase === "error");
      expect(lifecycleError?.data?.terminalDelivery).toEqual({ status: "failed", resultCount: 0 });
      for (const field of ["stopReason", "terminalReceipt", "terminalReply"]) {
        expect(lifecycleError?.data).not.toHaveProperty(field);
      }
      expect(JSON.stringify(lifecycleError)).not.toContain(secret);
      expect(JSON.stringify(lifecycleError)).not.toContain("discord:dm:private");
    });
  });

  it("preserves rejected best-effort delivery intent without private Incognito diagnostics", async () => {
    const {
      state,
      agentCommand,
      setupSingleAttemptFallback,
      setupBareStoredSession,
      makeSuccessResult,
    } = getFixture();
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    const now = Date.now();
    setupBareStoredSession({ incognito: true, createdAt: now, updatedAt: now });
    state.resolveAgentDeliveryPlanWithSessionRouteMock.mockResolvedValueOnce({
      baseDelivery: {},
      resolvedChannel: "discord",
      resolvedTo: "channel:missing",
      deliveryTargetMode: "explicit",
      targetResolutionError: new Error('Unknown Discord target "channel:missing"'),
    });

    await expect(
      agentCommand({
        message: "hello",
        channel: "discord",
        to: "channel:missing",
        deliver: true,
        bestEffortDeliver: true,
      }),
    ).resolves.toMatchObject({ payloads: [{ text: "ok" }] });

    expect(state.runAgentAttemptMock).toHaveBeenCalled();
    expect(state.commandWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("delivery preflight failed"),
    );
    const diagnostics = JSON.stringify(state.commandWarnMock.mock.calls);
    expect(diagnostics).not.toContain("channel:missing");
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ opts: expect.objectContaining({ deliver: true }) }),
    );
    const pendingEntries = state.persistSessionEntryMock.mock.calls
      .map((call) => (call[0] as { entry?: SessionEntry }).entry)
      .filter((entry): entry is SessionEntry => entry?.pendingFinalDelivery !== undefined);
    expect(pendingEntries).toEqual([]);
  });

  it("does not capture restart status as a final before the outer signal aborts", async () => {
    const { state, agentCommand, setupSingleAttemptFallback, setupBareStoredSession } =
      getFixture();
    setupSingleAttemptFallback();
    setupBareStoredSession();
    const controller = new AbortController();
    const assistant = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "pending-wait", name: "exec", arguments: {} }],
    });
    const attempt = makeEmbeddedRunnerAttempt({
      terminal: {
        kind: "aborted",
        source: "runtime",
        failure: { error: createAgentRunRestartAbortError(), source: "prompt" },
      },
      assistantTexts: [],
      lastAssistant: assistant,
      currentAttemptAssistant: assistant,
      lastToolError: { toolName: "exec", error: "Tool execution aborted" },
    });
    const input = makeTerminalInput({
      attempt,
      payloadsWithToolMedia: [{ text: "Gateway restarting…" }],
      runParams: { abortSignal: controller.signal, authProfileStateMode: "read-only" },
    });
    const terminal = await resolveEmbeddedRunTerminal(input);
    expect(terminal.action).toBe("complete");
    if (terminal.action !== "complete") {
      throw new Error("Restart interruption must not retry the model");
    }
    expect(terminal.result.meta).toMatchObject({ aborted: true, stopReason: "restart" });
    expect(input.sessionPromptState.activateInternalPrompt).not.toHaveBeenCalled();
    state.runAgentAttemptMock.mockResolvedValue(terminal.result);

    await expect(
      agentCommand({
        message: "continue after the pending wait",
        to: "+1234567890",
        abortSignal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError", code: "OPENCLAW_RESTART_ABORT" });

    expect(controller.signal.aborted).toBe(false);
    expect(state.runAgentAttemptMock).toHaveBeenCalledOnce();
    expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
    const persistedEntries = state.persistSessionEntryMock.mock.calls.map(
      (call) => (call[0] as { entry?: SessionEntry }).entry,
    );
    expect(persistedEntries.some((entry) => entry?.pendingFinalDelivery !== undefined)).toBe(false);
    expect(state.emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: "lifecycle",
        data: expect.objectContaining({ phase: "error", aborted: true, stopReason: "restart" }),
      }),
    );
  });
}
