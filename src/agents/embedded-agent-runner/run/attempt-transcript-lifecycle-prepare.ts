/** Prepares the admitted writer context and teardown tracker for one attempt. */
import { getReplyOperationSessionReader } from "../../../auto-reply/reply/reply-run-registry.state.js";
import { prepareSessionEntryReplacementDatabase } from "../../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { createSessionActorFactory } from "../../../config/sessions/session-actor-durable.js";
import { prepareCronRootSessionGeneration } from "../../../config/sessions/session-delivery-generation.js";
import { assertSessionEntryCohortScope } from "../../../config/sessions/session-entry-cohort-scope.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  type OwnedSessionTranscriptWriteContext,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { readDatabasePathIdentitySync } from "../../../infra/sqlite-worker-identity.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import { captureSessionManagerIncognitoBinding } from "../../sessions/session-manager-incognito-scope.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function prepareEmbeddedAttemptTranscriptLifecycle(input: {
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
  ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext;
  transcriptLifecycle: ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}> {
  const { attempt, externalAbortController } = input;
  const preparedTarget = attempt.preparedSessionTarget;
  preparedTarget?.assertCurrent();
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionManager?.getSessionTarget() ?? attempt.sessionTarget,
  });
  const sessionTarget =
    preparedTarget?.target ??
    (await resolveAgentRunSessionTarget({
      agentId: attempt.sessionTarget?.agentId,
      config: attempt.config,
      missingSessionKey: "resolve-existing",
      sessionFile: attempt.sessionFile,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
    }));
  await externalAbortController.throwIfFiredAfterPrepCleanup();
  preparedTarget?.assertCurrent();
  initialWriter?.assertActive();

  const fencedSessionTarget = {
    ...sessionTarget,
    expectedLifecycleRevision: attempt.sessionTarget?.expectedLifecycleRevision,
    expectedWriterRunId: attempt.sessionTarget?.expectedWriterRunId,
  };
  // The stable cron root can rotate while its exact run remains stored. Retain
  // its admitted generation only for this attempt, before compaction adoption.
  const generation = await prepareCronRootSessionGeneration(
    {
      ...sessionTarget,
      sessionKey: attempt.sessionKey ?? sessionTarget.sessionKey,
      lifecycleRevision: fencedSessionTarget.expectedLifecycleRevision,
    },
    input.runAbortController ? (reason) => input.runAbortController?.abort(reason) : undefined,
  );
  const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    onDrained: async () => {
      try {
        await ownedTranscriptWriteContext.sessionActor?.actor.release();
      } finally {
        try {
          await releaseIncognito?.();
        } finally {
          generation?.release();
        }
      }
    },
  });
  let releaseIncognito: (() => Promise<void>) | undefined;
  const assertAdmittedActive = attempt.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(attempt.admittedRunContext, attempt.abortSignal)
    : undefined;
  const withTranscriptWrite: WithOwnedTranscriptWrite = (operation) =>
    initialWriter
      ? initialWriter.withTranscriptWrite(() => transcriptLifecycle.withTranscriptWrite(operation))
      : transcriptLifecycle.withTranscriptWrite(operation);
  const ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext = {
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: fencedSessionTarget,
    sessionReader: getReplyOperationSessionReader(attempt.replyOperation),
    ...(initialWriter ? { initialWriter } : {}),
    assertCommitAllowed: composeSessionSourceAssertion(
      [assertAdmittedActive, generation?.assertCurrent],
      (assertSources) => {
        attempt.abortSignal?.throwIfAborted();
        assertSources();
      },
    ),
    withTranscriptWrite,
  };
  try {
    const assertCurrent = () => {
      preparedTarget?.assertCurrent();
      initialWriter?.assertActive();
      ownedTranscriptWriteContext.assertCommitAllowed?.();
    };
    assertCurrent();
    // Detached helpers keep their caller-owned transcript and never open durable storage.
    if (attempt.sessionPersistence !== "detached") {
      const reader = ownedTranscriptWriteContext.sessionReader;
      if (reader) {
        assertSessionEntryCohortScope(reader, fencedSessionTarget);
      }
      const options =
        reader?.database ?? toDatabaseOptions(resolveSqliteReadScope(fencedSessionTarget));
      const database = {
        ...options,
        env: Object.freeze({ ...(options.env ?? process.env) }),
        path: resolveOpenClawAgentSqlitePath(options),
      };
      const lifetime = { assertCurrent, assertReadable: assertCurrent };
      const incognito = captureSessionManagerIncognitoBinding(
        fencedSessionTarget,
        attempt.sessionManager,
      );
      if (incognito && "kind" in incognito) {
        ownedTranscriptWriteContext.sessionActor = {
          actor: await incognito.storage.acquire(sessionTarget.sessionKey, lifetime),
          database: incognito.database,
        };
      } else if (incognito) {
        const execution = await captureOpenClawAgentDatabaseExecution({
          kind: "ephemeral",
          agentId: incognito.actor.agentId,
          env: database.env,
          authority: lifetime,
          existingOnly: true,
        });
        if (!execution) {
          throw new Error("Attempt lost its captured incognito owner");
        }
        releaseIncognito = () => execution.release();
        ownedTranscriptWriteContext.sessionActor = {
          actor: await execution.sessionActors.acquire(
            { database: incognito.actor.identity, sessionKey: sessionTarget.sessionKey },
            lifetime,
          ),
          database,
        };
      } else if (!isIncognitoOpenClawAgentSqlitePath(database.path, database)) {
        // Native incognito retains its existing transcript owner until the worker cutover.
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
    compactionTimeoutMs: resolveCompactionTimeoutMs(attempt.config),
    assertCronRootCurrent: generation ? ownedTranscriptWriteContext.assertCommitAllowed : undefined,
    ownedTranscriptWriteContext,
    transcriptLifecycle,
    withOwnedTranscriptWrite: (operation) =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        withTranscriptWrite(operation),
      ),
  };
}
