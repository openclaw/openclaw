import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { registerGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { agentCommand } from "./agent-command.js";
import type { CommandSessionEntryFixture } from "./agent-command.live-model-switch.test-helpers.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "./agent-harness-completion-scope.js";
import { resolveEmbeddedRunTerminal } from "./embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "./embedded-agent-runner/run/terminal-resolution.test-support.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  registerGeneratedMediaTaskActivity,
  clearGeneratedMediaTaskActivity,
} from "./media-generation-activity.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "./run-termination.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

type AgentCommandRecoveryFixture = {
  state: {
    runAgentAttemptMock: Mock;
    runWithModelFallbackMock: Mock;
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
): Promise<void> {
  await withOpenClawTestState({ label: "command-recovery-delivery" }, async (testState) => {
    const scope = {
      agentId: "default",
      sessionKey: "agent:default:main",
      storePath: path.join(testState.sessionsDir("default"), "sessions.json"),
    };
    const { entry } = fixture.setupBareStoredSession({}, scope.storePath, scope.sessionKey);
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
  it.each([
    { kind: "public", notice: true },
    { kind: "legacy", notice: false },
    { kind: "private", notice: true },
    { kind: "transport", notice: true },
    { kind: "generated-handoff", notice: false },
    { kind: "owner-replaced", notice: false },
    { kind: "delivery-failure", notice: true },
    { kind: "restart", notice: false },
    { kind: "abort", notice: false },
    { kind: "superseded", notice: false },
    { kind: "returned-error", notice: true },
    { kind: "fallback-success", notice: false },
    { kind: "pending-reply", notice: false },
    { kind: "delivered-reply", notice: false },
    { kind: "pending-receipt", notice: false },
    { kind: "delivered-receipt", notice: false },
  ] as const)(
    "settles restart failure notification from execution and delivery custody ($kind)",
    async ({ kind, notice }) => {
      const fixture = getFixture();
      fixture.setupSingleAttemptFallback();
      await withStoredAgentCommandRecoverySession(fixture, async (scope) => {
        const runId = "restart-refusal-run";
        const sourceRunId = "channel-user:original";
        const publicMessage =
          "The interrupted task could not safely continue. Its history is preserved.";
        const failure =
          kind === "restart"
            ? createAgentRunRestartAbortError()
            : kind === "abort"
              ? createAgentRunDirectAbortError()
              : kind === "superseded"
                ? createAgentRunSupersededAbortError()
                : kind === "generated-handoff"
                  ? new LiveSessionModelSwitchError({ provider: "anthropic", model: "claude" })
                  : kind === "transport"
                    ? new Error("private native transport diagnostic")
                    : new AgentHarnessPreflightError("private recovery diagnostic", {
                        userMessage: kind === "private" ? undefined : publicMessage,
                      });
        const { entry } = fixture.setupBareStoredSession(
          {
            ...sessionAccessor.loadSessionEntry(scope),
            restartRecoveryDeliveryRunId: runId,
            restartRecoveryDeliverySourceRunId: sourceRunId,
            restartRecoverySourceIngress: "channel",
            restartRecoverySourceReplyDeliveryMode: "message_tool_only",
            restartRecoveryDeliveryContext: { channel: "slack", to: "C123", threadId: "123.456" },
            restartRecoveryFailureNoticeAllowed: kind === "legacy" ? undefined : true,
            restartRecoveryDeliveryReceiptState:
              kind === "pending-receipt"
                ? "terminal-pending"
                : kind === "delivered-receipt"
                  ? "delivered-terminal"
                  : undefined,
          },
          scope.storePath,
          scope.sessionKey,
        );
        await sessionAccessor.replaceSessionEntry(scope, entry);
        const returnsResult =
          kind === "returned-error" ||
          kind === "fallback-success" ||
          kind === "pending-reply" ||
          kind === "delivered-reply";
        if (returnsResult) {
          const originalFallback = fixture.state.runWithModelFallbackMock.getMockImplementation()!;
          const result =
            kind === "fallback-success"
              ? fixture.makeSuccessResult("anthropic", "claude")
              : {
                  payloads: [{ text: "private terminal detail", isError: true }],
                  sourceReplyDeliveryState:
                    kind === "pending-reply"
                      ? "pending"
                      : kind === "delivered-reply"
                        ? "delivered"
                        : "missing",
                  meta: {
                    durationMs: 100,
                    aborted: false,
                    stopReason: "end_turn",
                    error: {
                      kind: "incomplete_turn",
                      message: "private terminal diagnostic",
                      fallbackSafe: true,
                      terminalPresentation: true,
                    },
                    agentMeta: { provider: "anthropic", model: "claude" },
                  },
                };
          if (kind === "fallback-success") {
            fixture.state.runAgentAttemptMock
              .mockRejectedValueOnce(new Error("temporary transport error"))
              .mockResolvedValueOnce(result);
            fixture.state.runWithModelFallbackMock.mockImplementationOnce(async (...args) => {
              await originalFallback(...args).catch(() => undefined);
              return originalFallback(...args);
            });
          } else {
            fixture.state.runAgentAttemptMock.mockResolvedValueOnce(result);
            fixture.state.runWithModelFallbackMock.mockImplementationOnce(async (...args) => ({
              ...(await originalFallback(...args)),
              outcome: "exhausted",
            }));
          }
        } else {
          fixture.state.runAgentAttemptMock.mockImplementationOnce(async () => {
            if (kind === "generated-handoff") {
              registerGeneratedMediaTaskActivity(`${runId}:media`, scope.sessionKey, scope.agentId);
            }
            if (kind === "owner-replaced") {
              await sessionAccessor.updateSessionEntry(scope, () => ({
                restartRecoveryDeliveryRunId: "successor-run",
                restartRecoveryDeliverySourceRunId: "successor-source",
              }));
            }
            throw failure;
          });
        }
        const sendRecoveryNotice = vi.fn<GatewayRecoveryRuntime["sendRecoveryNotice"]>(
          async (payload) => {
            expect(payload.isCurrent?.({})).toBe(true);
            expect(sessionAccessor.loadSessionEntry(scope)?.restartRecoveryDeliveryRunId).toBe(
              runId,
            );
            if (kind === "delivery-failure") {
              throw new Error("outbound delivery unavailable");
            }
            return { suppressed: false };
          },
        );
        const unused = async () => {
          throw new Error("unexpected recovery dispatch");
        };
        const unregister = registerGatewayRecoveryRuntime({
          dispatchSessionMethod: unused,
          dispatchAgent: unused,
          waitForAgent: unused,
          sendRecoveryNotice,
        });
        try {
          const command = fixture.agentCommand({
            message: "Continue the interrupted task",
            sessionKey: scope.sessionKey,
            runId,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only",
            inputProvenance: {
              kind: "internal_system",
              sourceTool: "main_session_restart_recovery",
            },
          });
          if (returnsResult) {
            await command;
          } else {
            await expect(command).rejects.toBe(failure);
          }
          expect(sendRecoveryNotice).toHaveBeenCalledTimes(notice ? 1 : 0);
          if (notice) {
            const sent = sendRecoveryNotice.mock.calls[0] as unknown as [Record<string, unknown>];
            expect(sent[0]).toMatchObject({
              channel: "slack",
              to: "C123",
              threadId: "123.456",
              idempotencyKey: `main-session-restart-recovery:${sourceRunId}:failed-notice`,
            });
            expect(sent[0].text).not.toContain("private");
            if (kind === "public" || kind === "delivery-failure") {
              expect(sent[0].text).toBe(publicMessage);
            }
          }
          if (kind !== "restart" && kind !== "owner-replaced") {
            const terminal = sessionAccessor.loadSessionEntry(scope);
            expect(terminal?.restartRecoveryDeliveryRunId).toBeUndefined();
            expect(terminal?.restartRecoveryFailureNoticeAllowed).toBeUndefined();
            expect(terminal?.restartRecoveryTerminalRunIds).toContain(sourceRunId);
          }
          if (kind === "public") {
            expect(sendRecoveryNotice.mock.calls[0]?.[0].isCurrent?.({})).toBe(false);
            const current = sessionAccessor.loadSessionEntry(scope);
            fixture.setupBareStoredSession(current, scope.storePath, scope.sessionKey);
            fixture.state.runAgentAttemptMock.mockResolvedValueOnce(
              fixture.makeSuccessResult("anthropic", "claude"),
            );
            await fixture.agentCommand({
              message: "A new direct request",
              sessionKey: scope.sessionKey,
              runId: "later-direct-request",
              deliver: false,
            });
            expect(sendRecoveryNotice).toHaveBeenCalledOnce();
          }
        } finally {
          clearGeneratedMediaTaskActivity(`${runId}:media`);
          unregister();
        }
      });
    },
  );

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

  it("clears the native admitted completion claim when cancellation wins after its commit", async () => {
    const { state, agentCommand, setupSingleAttemptFallback, setupBareStoredSession } =
      getFixture();
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-claim-cancel-")),
    );
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sessionKey = "agent:default:main";
        const sourceRunId = "announce:harness:cancel-after-commit";
        const childRunId = "harness:cancel-child";
        const controller = new AbortController();
        setupSingleAttemptFallback();
        const storePath = path.join(stateDir, "agents/default/sessions/sessions.json");
        const { entry } = setupBareStoredSession({}, storePath, sessionKey);
        await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
        state.resolvedSessionKeyMock = sessionKey;
        const { persistAgentSession: persist } = await vi.importActual<
          typeof import("./command/attempt-execution.shared.js")
        >("./command/attempt-execution.shared.js");
        let committed = false;
        state.persistSessionEntryMock.mockImplementation(async (...args: unknown[]) => {
          const result = await persist(args[0] as Parameters<typeof persist>[0]);
          if (!committed && result?.restartRecoveryHarnessCompletion?.taskRunId === childRunId) {
            committed = true;
            controller.abort();
          }
          return result;
        });
        await expect(
          withAgentHarnessCompletionAdmission(
            {
              scope: createAgentHarnessCompletionScope({
                requesterSessionKey: sessionKey,
                requesterAgentId: "default",
              }),
              sourceSessionKey: childRunId,
              sourceRunId,
              requesterSessionId: entry.sessionId,
              requesterLifecycleRevision: entry.lifecycleRevision,
              isSourceCurrent: () => !controller.signal.aborted,
            },
            () =>
              agentCommand({
                message: "child finished",
                abortSignal: controller.signal,
                assertSourceCurrent: () => controller.signal.throwIfAborted(),
                sessionKey,
                runId: sourceRunId,
                channel: "discord",
                to: "discord:dm:123",
                deliver: true,
                inputProvenance: {
                  kind: "inter_session",
                  sourceTool: "agent_harness_task",
                  sourceChannel: "internal",
                  sourceSessionKey: childRunId,
                },
              }),
          ),
        ).rejects.toThrow();
        expect(committed).toBe(true);
        expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
        const saved = sessionAccessor.loadSessionEntry({ sessionKey, storePath });
        expect(saved?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(saved?.restartRecoveryHarnessCompletion).toBeUndefined();
        expect(controller.signal.aborted).toBe(true);
        expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      });
    } finally {
      await closeOpenClawAgentDatabasesAsync();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
}
