import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { prepareSessionEntryReplacementDatabase } from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { prepareCronRootSessionGeneration } from "../../../config/sessions/session-delivery-generation.js";
import { assertSessionEntryCohortScope } from "../../../config/sessions/session-entry-cohort-scope.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import type { OwnedSessionTranscriptWriteContext } from "../../../config/sessions/transcript-write-context-store.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { captureAgentRunTerminalPersistence } from "../../../infra/agent-run-terminal-writes.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
/** Prepares the admitted writer context and teardown tracker for one attempt. */
import { getReplyOperationSessionReader } from "../../../sessions/session-controller.session-reader.js";
import { IncognitoSessionMissingError } from "../../../state/incognito-session-error.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import { isAgentRunRestartAbortReason } from "../../run-termination.js";
import { captureSessionManagerIncognitoBinding } from "../../sessions/session-manager-incognito-scope.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function prepareEmbeddedAttemptTranscriptLifecycle({
  runAbortController,
  attempt: {
    abortSignal,
    admittedRunContext,
    config,
    runId,
    replyOperation,
    sessionFile,
    sessionId,
    sessionKey,
    sessionManager,
    sessionPersistence,
    sessionTarget: originalSessionTarget,
    preparedSessionTarget: preparedTarget,
  },
  externalAbortController,
}: {
  runAbortController?: AbortController;
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    | "abortSignal"
    | "config"
    | "runId"
    | "replyOperation"
    | "sessionFile"
    | "sessionId"
    | "sessionKey"
    | "sessionManager"
    | "sessionPersistence"
    | "sessionTarget"
    | "preparedSessionTarget"
  > & { admittedRunContext?: EmbeddedRunAttemptParams["admittedRunContext"] };
  externalAbortController: {
    arm: () => void;
    throwIfFiredAfterPrepCleanup: () => Promise<void>;
  };
}): Promise<{
  compactionTimeoutMs: number;
  assertCronRootCurrent?: () => void;
  ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext & {
    sessionTarget: SessionTranscriptRuntimeTarget;
  };
  transcriptLifecycle: ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}> {
  preparedTarget?.assertCurrent();
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionFile,
    sessionKey,
    sessionTarget: sessionManager?.getSessionTarget() ?? originalSessionTarget,
  });
  const sessionTarget =
    preparedTarget?.target ??
    (await resolveAgentRunSessionTarget({
      agentId: originalSessionTarget?.agentId,
      config,
      missingSessionKey: "resolve-existing",
      sessionFile,
      sessionId,
      sessionKey,
      sessionPersistence,
      sessionTarget: originalSessionTarget,
    }));
  await externalAbortController.throwIfFiredAfterPrepCleanup();
  preparedTarget?.assertCurrent();
  initialWriter?.assertActive();

  const fencedSessionTarget = {
    ...sessionTarget,
    expectedLifecycleRevision: originalSessionTarget?.expectedLifecycleRevision,
    expectedWriterRunId: originalSessionTarget?.expectedWriterRunId,
  };
  // The stable cron root can rotate while its exact run remains stored. Retain
  // its admitted generation only for this attempt, before compaction adoption.
  const generation = await prepareCronRootSessionGeneration(
    {
      ...sessionTarget,
      sessionKey: sessionKey ?? sessionTarget.sessionKey,
      lifecycleRevision: fencedSessionTarget.expectedLifecycleRevision,
    },
    runAbortController ? (reason) => runAbortController.abort(reason) : undefined,
  );
  const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId,
    sessionId,
    onDrained: async () => {
      try {
        await ownedTranscriptWriteContext.sessionActor?.actor.release();
      } finally {
        generation?.release();
      }
    },
  });
  const assertAdmittedActive = admittedRunContext
    ? resolveAdmittedRunActiveAssertion(admittedRunContext, abortSignal)
    : undefined;
  const { writeContext: terminalWriter } = captureAgentRunTerminalPersistence(runId);
  const assertTerminalCurrent = composeSessionSourceAssertion([
    terminalWriter?.assertCurrent,
    generation?.assertCurrent,
  ]);
  const withTranscriptWrite: WithOwnedTranscriptWrite = (operation) =>
    initialWriter
      ? initialWriter.withTranscriptWrite(() => transcriptLifecycle.withTranscriptWrite(operation))
      : transcriptLifecycle.withTranscriptWrite(operation);
  const ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext & {
    sessionTarget: SessionTranscriptRuntimeTarget;
  } = {
    sessionFile,
    sessionKey,
    sessionTarget: fencedSessionTarget,
    sessionReader: getReplyOperationSessionReader(replyOperation),
    ...(initialWriter ? { initialWriter } : {}),
    assertCommitAllowed: composeSessionSourceAssertion(
      [assertAdmittedActive, generation?.assertCurrent],
      (assertSources) => {
        abortSignal?.throwIfAborted();
        preparedTarget?.assertCurrent();
        assertSources();
      },
    ),
    withTranscriptWrite,
    withRestartAbortWrite: terminalWriter
      ? async (write) => {
          if (
            !isAgentRunRestartAbortReason(abortSignal?.reason) &&
            !isAgentRunRestartAbortReason(runAbortController?.signal.reason)
          ) {
            throw new Error("Interrupted transcript write requires a restart abort");
          }
          const fence = initialWriter?.committedFence ?? fencedSessionTarget;
          // Settlement may append to an existing writer, never create an uncommitted session.
          if (!fence.expectedWriterRunId || (initialWriter && !initialWriter.committedFence)) {
            throw new SessionTranscriptWriterClaimReboundError();
          }
          return await transcriptLifecycle.withTranscriptWrite(() =>
            terminalWriter.run(() =>
              withOwnedSessionTranscriptWrites(
                {
                  ...ownedTranscriptWriteContext,
                  sessionTarget: { ...fencedSessionTarget, ...fence },
                  initialWriter: undefined,
                  settledInitialWriter: initialWriter,
                  sessionReader: undefined,
                  assertCommitAllowed: assertTerminalCurrent,
                  withTranscriptWrite: (operation) =>
                    transcriptLifecycle.withTranscriptWrite(operation),
                  withRestartAbortWrite: undefined,
                },
                write,
              ),
            ),
          );
        }
      : undefined,
  };
  try {
    const assertCurrent = () => {
      initialWriter?.assertActive();
      ownedTranscriptWriteContext.assertCommitAllowed?.();
    };
    assertCurrent();
    // Detached helpers keep their caller-owned transcript and never open durable storage.
    if (sessionPersistence !== "detached") {
      const reader = ownedTranscriptWriteContext.sessionReader;
      if (reader) {
        assertSessionEntryCohortScope(reader, fencedSessionTarget);
      }
      // Execution cancellation does not revoke the actor needed to record its outcome.
      // Ordinary writes still pass assertCommitAllowed; terminal writes retain source and writer fences.
      const assertActorCurrent = terminalWriter ? assertTerminalCurrent : assertCurrent;
      const lifetime = { assertCurrent: assertActorCurrent, assertReadable: assertActorCurrent };
      const incognito = captureSessionManagerIncognitoBinding(fencedSessionTarget, sessionManager);
      if (incognito) {
        const actor = await incognito.acquire(false, lifetime);
        if (!actor) {
          throw new IncognitoSessionMissingError();
        }
        ownedTranscriptWriteContext.sessionActor = {
          actor,
          database: incognito.database,
        };
      } else {
        const options =
          reader?.database ?? toDatabaseOptions(resolveSqliteReadScope(fencedSessionTarget));
        const database = {
          ...options,
          env: Object.freeze({ ...(options.env ?? process.env) }),
          path: resolveOpenClawAgentSqlitePath(options),
        };
        const { createSessionActorFactory } =
          await import("../../../config/sessions/session-actor-durable.js");
        assertCurrent();
        let identity = readDatabasePathIdentitySync(database.path);
        if (identity.key.startsWith("path:")) {
          await prepareSessionEntryReplacementDatabase(database, assertCurrent);
          assertCurrent();
          identity = readDatabasePathIdentitySync(database.path);
        }
        const actor = await createSessionActorFactory(database).acquire(
          {
            database: {
              kind: "file",
              physicalIdentity: identity.key.slice("file:".length),
              birthtime: identity.birthtime,
              nativeLocation: identity.canonicalPath,
            },
            sessionKey: sessionTarget.sessionKey,
          },
          lifetime,
        );
        if ("kind" in actor) {
          throw new Error("Durable session actor acquisition was declined");
        }
        ownedTranscriptWriteContext.sessionActor = {
          actor,
          database,
        };
      }
    }
    externalAbortController.arm();
    await externalAbortController.throwIfFiredAfterPrepCleanup();
    preparedTarget?.assertCurrent();
  } catch (error) {
    await transcriptLifecycle.dispose();
    throw error;
  }

  return {
    compactionTimeoutMs: resolveCompactionTimeoutMs(config),
    assertCronRootCurrent: generation ? ownedTranscriptWriteContext.assertCommitAllowed : undefined,
    ownedTranscriptWriteContext,
    transcriptLifecycle,
    withOwnedTranscriptWrite: (operation) =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        withTranscriptWrite(operation),
      ),
  };
}
