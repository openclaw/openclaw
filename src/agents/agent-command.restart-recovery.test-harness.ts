import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { agentCommand } from "./agent-command.js";
import type { CommandSessionEntryFixture } from "./agent-command.live-model-switch.test-helpers.js";

type AgentCommandRecoveryFixture = {
  state: {
    runAgentAttemptMock: Mock;
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

  it("clears the admitted completion claim when cancellation wins after its commit", async () => {
    const { state, agentCommand, setupSingleAttemptFallback, setupBareStoredSession } =
      getFixture();
    const stateDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-claim-cancel-")),
    );
    const { createAgentHarnessTaskRuntime } =
      await import("../plugin-sdk/agent-harness-task-runtime.js");
    const { createAgentHarnessTaskRuntimeScope } =
      await import("../tasks/agent-harness-task-runtime-scope.js");
    const { markTaskTerminalById, getTaskById } = await import("../tasks/task-registry.js");
    const { resetTaskRegistryForTests } = await import("../tasks/task-registry.test-support.js");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        resetTaskRegistryForTests();
        const sessionKey = "agent:default:main";
        const sourceRunId = "announce:harness:cancel-after-commit";
        const childRunId = "harness:cancel-child";
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-native",
          scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: sessionKey }),
        });
        const task = runtime.createRunningTaskRun({
          runId: childRunId,
          sourceId: childRunId,
          task: "work",
          requesterAgentId: "default",
          notifyPolicy: "silent",
        });
        runtime.finalizeTaskRunByRunId({
          runId: childRunId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: "result",
        });
        runtime.setDetachedTaskDeliveryStatusByRunId({
          runId: childRunId,
          deliveryStatus: "pending",
        });
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
          if (!committed && result?.restartRecoveryHarnessCompletion?.taskId === task.taskId) {
            committed = true;
            markTaskTerminalById({ taskId: task.taskId, status: "cancelled", endedAt: Date.now() });
          }
          return result;
        });
        await expect(
          agentCommand({
            message: "child finished",
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
        ).rejects.toThrow();
        expect(committed).toBe(true);
        expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
        const saved = sessionAccessor.loadSessionEntry({ sessionKey, storePath });
        expect(saved?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(saved?.restartRecoveryHarnessCompletion).toBeUndefined();
        expect(getTaskById(task.taskId)?.status).toBe("cancelled");
      });
    } finally {
      resetTaskRegistryForTests();
      await closeOpenClawAgentDatabasesAsync();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
}
