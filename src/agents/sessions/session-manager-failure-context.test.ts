import path from "node:path";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "./session-manager.js";

it("persists storage worker memory guidance for a native worker OOM", async () => {
  await withOpenClawTestState({ label: "storage-worker-memory" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "storage-worker-memory",
      sessionKey: "agent:main:storage-worker-memory",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const nativeOom = Object.assign(
      new Error("Worker terminated due to reaching memory limit: JS heap out of memory"),
      { code: "ERR_WORKER_OUT_OF_MEMORY" },
    );
    const workerFailure = new SqliteWorkerError(
      "SQLite worker stopped before its result was received",
      "unavailable",
    );
    workerFailure.cause = nativeOom;

    await recordGatewaySessionRunFailure({
      target: scope,
      runId: "oom-run",
      error: workerFailure,
    });
    await waitForSessionTranscriptProjection(scope);

    expect(await loadTranscriptEvents(scope)).toContainEqual(
      expect.objectContaining({
        type: "custom_message",
        customType: "run-failed-before-reply",
        display: true,
        content:
          "⚠️ OpenClaw's storage worker ran out of memory. Ask the Gateway operator to check the logs and address memory or resource pressure before trying again. Restarting this session alone will not fix the underlying problem. For details, open Settings → Logs in the Control UI or run `openclaw logs --follow` in your terminal.",
      }),
    );
  });
});

it.each([{ generation: "new" }, { generation: "existing" }])(
  "keeps a $generation run failure visible without replaying it as user context",
  async ({ generation }) => {
    await withOpenClawTestState({ label: "failure-notice-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "failure-notice-context",
        sessionKey: "agent:main:failure-notice-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync(makeUserMessage("original request", 1));
      await source.appendCustomMessageEntryAsync("context", "retained custom context", true);
      if (generation === "new") {
        await recordGatewaySessionRunFailure({
          target: scope,
          runId: "failed-run",
          error: "Synthetic run failure",
        });
      } else {
        await source.appendCustomMessageEntryAsync(
          "run-failed-before-reply",
          "Your request couldn't be completed: Synthetic run failure",
          true,
          { runId: "failed-run", error: "Synthetic run failure" },
        );
      }
      await waitForSessionTranscriptProjection(scope);
      expect(await loadTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          display: true,
          content:
            generation === "new"
              ? "Your request couldn't be completed."
              : "Your request couldn't be completed: Synthetic run failure",
        }),
      );
      const context = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
      expect(context.messages.map((message) => "content" in message && message.content)).toEqual([
        "original request",
        "retained custom context",
      ]);
    });
  },
);
