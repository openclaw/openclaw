import path from "node:path";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { createTranscriptMirrorTestHarness } from "./transcript-mirror.test-harness.js";

/** Exercises native projection and persistence without a provider process. */
export function createCodexAbortTranscriptTestHarness() {
  registerCodexEventProjectorTestLifecycle();
  const { createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();

  return {
    createTarget: () => createSqliteMirrorTarget("openclaw-codex-abort-owner-"),
    async createTurn(
      target: Awaited<ReturnType<typeof createSqliteMirrorTarget>>,
      turn: { runId: string; turnId: string; text: string },
    ) {
      const params = {
        ...(await createParams()),
        ...target,
        sessionTarget: target,
        workspaceDir: path.dirname(target.storePath),
        runId: turn.runId,
        suppressNextUserMessagePersistence: true,
      };
      const threadId = "thread-abort-owner";
      const projector = new CodexAppServerEventProjector(params, threadId, turn.turnId);
      await projector.handleNotification({
        method: "item/started",
        params: {
          threadId,
          turnId: turn.turnId,
          item: { type: "agentMessage", id: "partial", phase: "final_answer", text: "" },
        },
      });
      await projector.handleNotification({
        method: "item/agentMessage/delta",
        params: { threadId, turnId: turn.turnId, itemId: "partial", delta: turn.text },
      });
      return {
        threadId,
        async finish(interrupted: boolean) {
          try {
            if (interrupted) {
              projector.markAborted();
            }
            await projector.handleNotification({
              method: "turn/completed",
              params: {
                threadId,
                turn: {
                  id: turn.turnId,
                  status: interrupted ? "interrupted" : "completed",
                  items: interrupted
                    ? []
                    : [
                        {
                          type: "agentMessage",
                          id: "partial",
                          phase: "final_answer",
                          text: turn.text,
                        },
                      ],
                  error: null,
                },
              },
            });
            return await codexTranscriptMirrorRuntime.mirrorBestEffort({
              params,
              result: projector.buildResult(buildEmptyToolTelemetry()),
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              notifyUserMessagePersisted: () => undefined,
              cwd: params.workspaceDir,
              threadId,
              turnId: turn.turnId,
            });
          } finally {
            await projector.closeProjection();
          }
        },
      };
    },
  };
}
