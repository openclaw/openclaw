import { expectDefined } from "@openclaw/normalization-core";
import * as agentHarnessTaskRuntime from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { AgentHarnessTaskRuntimeScope } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { runCopilotAttempt } from "./attempt.js";
import {
  makeAssistantMessageEvent,
  makeFailingNativeTaskRuntime,
  makeFakePool,
  makeFakeSdk,
  projectAgentRunAttemptTerminal,
  type FakeSdk,
  type FakeSession,
} from "./attempt.test-support.js";

export function registerCopilotNativeSubagentCleanupTests({
  makeParams,
  requireSession,
}: {
  makeParams: (overrides: {
    agentHarnessTaskRuntimeScope: AgentHarnessTaskRuntimeScope;
  }) => Parameters<typeof runCopilotAttempt>[0];
  requireSession: (sdk: FakeSdk) => FakeSession;
}) {
  it.each([false, true])(
    "waits for native task cancellation before disconnecting (deferred: %s)",
    async (deferred) => {
      const finalizationStarted = createDeferred<void>();
      const releaseFinalization = createDeferred<void>();
      const runtime = makeFailingNativeTaskRuntime(new Error("unused fallback"));
      const task = expectDefined(runtime.listTaskRecords()[0], "native task");
      runtime.finalizeTaskRunByRunIdAsync = async (params) => {
        finalizationStarted.resolve();
        await releaseFinalization.promise;
        Object.assign(task, { status: params.status, endedAt: params.endedAt });
        return [task];
      };
      vi.spyOn(agentHarnessTaskRuntime, "createAgentHarnessTaskRuntime").mockReturnValue(runtime);
      const sdk = makeFakeSdk((session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("user.message", { content: "hello" });
          session.emit("subagent.started", {
            agentDescription: "inspect",
            agentDisplayName: "Worker",
            agentName: "worker",
            toolCallId: "call-1",
          });
          if (deferred) {
            session.emit("session.compaction_start", {});
          }
          return makeAssistantMessageEvent("done");
        });
      });
      const pool = makeFakePool(sdk);
      const onDeferredCompaction = vi.fn<(params: { cleanup: Promise<unknown> }) => void>();
      const attempt = runCopilotAttempt(
        makeParams({ agentHarnessTaskRuntimeScope: {} as AgentHarnessTaskRuntimeScope }),
        { pool, onDeferredCompaction },
      );
      let cleanup: Promise<unknown> = attempt;
      if (deferred) {
        await attempt;
        cleanup = expectDefined(
          onDeferredCompaction.mock.calls[0]?.[0].cleanup,
          "deferred cleanup",
        );
        const session = requireSession(sdk);
        session.emit("session.compaction_complete", { success: true });
        session.emit("session.idle", {});
      }
      try {
        await finalizationStarted.promise;
        const session = requireSession(sdk);
        expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
        expect(session.disconnect).not.toHaveBeenCalled();
        expect(pool.release).not.toHaveBeenCalled();
      } finally {
        releaseFinalization.resolve();
        await cleanup;
      }
      expect(task.status).toBe("cancelled");
      expect(requireSession(sdk).disconnect).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "cleans up after native task finalization fails (deferred: %s)",
    async (deferred) => {
      const failure = new Error("native task persistence failed");
      const runtime = makeFailingNativeTaskRuntime(failure);
      vi.spyOn(agentHarnessTaskRuntime, "createAgentHarnessTaskRuntime").mockReturnValue(runtime);
      const sdk = makeFakeSdk((session) => {
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("user.message", { content: "hello" });
          session.emit("subagent.started", {
            agentDescription: "inspect",
            agentDisplayName: "Worker",
            agentName: "worker",
            toolCallId: "call-1",
          });
          if (deferred) {
            session.emit("session.compaction_start", {});
          }
          return makeAssistantMessageEvent("done");
        });
      });
      const pool = makeFakePool(sdk);
      const onDeferredCompaction = vi.fn<(params: { cleanup: Promise<unknown> }) => void>();
      const outcome = await runCopilotAttempt(
        makeParams({
          agentHarnessTaskRuntimeScope: {} as AgentHarnessTaskRuntimeScope,
        }),
        { pool, onDeferredCompaction },
      ).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      const session = requireSession(sdk);
      if (deferred) {
        const cleanup = expectDefined(
          onDeferredCompaction.mock.calls[0]?.[0].cleanup,
          "deferred cleanup",
        );
        session.emit("session.compaction_complete", { success: true });
        session.emit("session.idle", {});
        await expect(cleanup).rejects.toBe(failure);
      } else {
        expect(outcome.error).toBeUndefined();
        expect(
          projectAgentRunAttemptTerminal(expectDefined(outcome.result, "attempt result").terminal)
            .promptError,
        ).toBe(failure);
      }
      expect(session.disconnect).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
      expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
    },
  );
}
