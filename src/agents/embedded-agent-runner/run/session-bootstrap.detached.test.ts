import { expect, it, vi } from "vitest";
import * as sessionAccess from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import * as sessionCommand from "../../command/session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";
import { prepareEmbeddedRunSession } from "./session-bootstrap.js";

it.each(["agent:worker:setup-inference:incognito-detached-probe", undefined])(
  "prepares a detached memory transcript without consulting durable rows (key: %s)",
  async (sessionKey) => {
    await withOpenClawTestState({ label: "detached-session-target" }, async (state) => {
      const config = { agents: { entries: { worker: { workspace: state.workspaceDir } } } };
      const sessionManager = SessionManager.inMemory(state.workspaceDir);
      const runId = "detached-probe";
      const admission = prepareSystemAgentRunAdmission(config, runId, "worker", "test");
      const cancellation = new AbortController();
      const admittedRunContext = await admission.admit("embedded");
      const reads = vi.spyOn(sessionAccess, "resolveSessionTranscriptRuntimeTarget");
      const backfill = vi.spyOn(sessionCommand, "resolveStoredSessionKeyForSessionId");
      let transcript:
        | Awaited<ReturnType<typeof prepareEmbeddedAttemptTranscriptLifecycle>>
        | undefined;
      try {
        const prepared = await prepareEmbeddedRunSession({
          config,
          agentId: "worker",
          sessionId: runId,
          sessionKey,
          sessionFile: sessionKey ? `in-memory:${runId}` : undefined,
          sessionManager,
          sessionPersistence: "detached",
          admittedRunContext,
          abortSignal: cancellation.signal,
          workspaceDir: state.workspaceDir,
          prompt: "Synthetic opening",
          timeoutMs: 30_000,
          runId,
        });
        expect(prepared.runSessionTarget).toMatchObject({
          agentId: "worker",
          sessionId: runId,
          sessionKey: sessionKey ?? "agent:worker:detached-probe",
        });
        transcript = await prepareEmbeddedAttemptTranscriptLifecycle({
          attempt: prepared.params,
          externalAbortController: {
            arm: () => {},
            throwIfFiredAfterPrepCleanup: async () => cancellation.signal.throwIfAborted(),
          },
        });
        expect(transcript.ownedTranscriptWriteContext.sessionTarget).toMatchObject(
          prepared.runSessionTarget,
        );
        expect(reads).not.toHaveBeenCalled();
        expect(backfill).not.toHaveBeenCalled();
        const message = { role: "user" as const, content: "Memory only", timestamp: 1 };
        await transcript.withOwnedTranscriptWrite(() => sessionManager.appendMessageAsync(message));
        expect(sessionManager.getBranch()).toEqual([
          expect.objectContaining({ type: "message", message }),
        ]);
        cancellation.abort(new Error("Detached run cancelled"));
        expect(() => transcript!.ownedTranscriptWriteContext.assertCommitAllowed?.()).toThrow(
          "Detached run cancelled",
        );
      } finally {
        await transcript?.transcriptLifecycle.dispose();
        reads.mockRestore();
        backfill.mockRestore();
        admission.close();
      }
    });
  },
);
