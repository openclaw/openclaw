import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Mock } from "vitest";
import { expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { agentCommand } from "./agent-command.js";
import type { CommandSessionEntryFixture } from "./agent-command.live-model-switch.test-helpers.js";
import {
  createAgentHarnessCompletionScope,
  withAgentHarnessCompletionAdmission,
} from "./agent-harness-completion-scope.js";
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
    resolveAgentDeliveryPlanWithSessionRouteMock: Mock;
    commandWarnMock: Mock;
    emitAgentEventMock: Mock;
    deliverAgentCommandResultMock: Mock;
    persistSessionEntryMock: Mock<(...args: unknown[]) => Promise<unknown>>;
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

export function registerAgentCommandRecoveryCases(
  getFixture: () => AgentCommandRecoveryFixture,
): void {
  it.each([false, true])(
    "preserves rejected best-effort delivery intent without private diagnostics (Incognito: %s)",
    async (incognito) => {
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
      setupBareStoredSession(incognito ? { incognito: true, createdAt: now, updatedAt: now } : {});
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
      if (incognito) {
        expect(diagnostics).not.toContain("channel:missing");
      } else {
        expect(diagnostics).toContain("channel:missing");
      }
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({ opts: expect.objectContaining({ deliver: true }) }),
      );
      const pendingEntries = state.persistSessionEntryMock.mock.calls
        .map((call) => (call[0] as { entry?: SessionEntry }).entry)
        .filter((entry): entry is SessionEntry => entry?.pendingFinalDelivery !== undefined);
      expect(pendingEntries).toEqual([]);
    },
  );

  it("persists and clears current run delivery context for restart recovery", async () => {
    const {
      state,
      agentCommand,
      setupSingleAttemptFallback,
      setupBareStoredSession,
      makeSuccessResult,
    } = getFixture();
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));
    setupBareStoredSession();
    state.deliverAgentCommandResultMock.mockResolvedValue({ deliverySucceeded: true });

    await agentCommand({
      message: "hello",
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "reply-1",
      deliver: true,
    });

    const persistedContexts = state.persistSessionEntryMock.mock.calls.map((call) => {
      const params = call[0] as { entry?: SessionEntry };
      return params.entry?.restartRecoveryDeliveryContext;
    });
    expect(persistedContexts).toContainEqual({
      channel: "discord",
      to: "discord:dm:123",
      accountId: "main",
      threadId: "reply-1",
    });
    const cleanupParams = state.persistSessionEntryMock.mock.calls.at(-1)?.[0] as
      | { sessionStore?: Record<string, SessionEntry> }
      | undefined;
    const stored = cleanupParams?.sessionStore?.["agent:main:main"];
    expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
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
    expect(input.activateInternalPrompt).not.toHaveBeenCalled();
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
