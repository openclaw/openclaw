import { randomUUID } from "node:crypto";
import type {
  SessionActor,
  SessionActorAppend,
  SessionActorAppendCommitted,
  SessionActorOutcome,
  SessionActorPhaseResults,
} from "../../config/sessions/session-actor-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/session-transcript-writer-claim-error.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { SessionManagerActorCommittedError } from "./session-manager-persistence-error.js";
import { unwrapSessionManagerPublication } from "./session-manager-publication.js";

type AppendValue =
  | SessionActorPhaseResults["appendTranscriptEvent"]
  | SessionActorPhaseResults["appendToolResult"];
type CommittedAppend = Extract<SessionActorOutcome<AppendValue>, { kind: "committed" }>;

/** One prepared append, with native commit evidence retained before caller publication. */
export async function appendSessionManagerActor(input: {
  actor: SessionActor;
  append: SessionActorAppend;
  toolResult: boolean;
  assertCurrent(this: void): void;
  beforeFreshMessageCommit?: () => void;
  onCommitted?(committed: SessionActorAppendCommitted): void;
}): Promise<{
  committed: SessionActorAppendCommitted;
  failure?: SessionManagerActorCommittedError;
}> {
  const { actor, assertCurrent } = input;
  const admission = captureSessionMessageAdmission(assertCurrent, input);
  const append: SessionActorAppend =
    input.append.kind === "message"
      ? { ...input.append, input: { ...input.append.input, ...admission.control } }
      : {
          ...input.append,
          input: {
            ...input.append.input,
            ...(input.append.input.message
              ? { message: { ...input.append.input.message, ...admission.control } }
              : {}),
          },
        };
  const authority = {
    assertCurrent,
    authorize: (stage: "transaction" | "commit", _facts: unknown, nativeFacts?: unknown) => {
      assertCurrent();
      admission.assertAdmission(unwrapSessionManagerPublication({ stage, facts: nativeFacts }));
      assertCurrent();
    },
  };
  assertCurrent();
  const snapshot = actor.snapshot(authority);
  let captured: CommittedAppend | undefined;
  let outcome: SessionActorOutcome<AppendValue>;
  try {
    const command = {
      commandId: randomUUID(),
      phaseId: "session-manager.append",
      expected: snapshot?.version,
      append,
    };
    const observer = {
      committed: (value: CommittedAppend) => {
        captured = value;
        if (value.receipt.transcript.append) {
          input.onCommitted?.(value.receipt.transcript.append);
        }
      },
    };
    const execute = () =>
      input.toolResult
        ? actor.appendToolResult(command, authority, observer)
        : actor.appendTranscriptEvent(command, authority, observer);
    outcome = await execute();
    // The typed stale reply proves no mutation ran; a captured commit always wins.
    if (outcome.kind === "stale-version" && !captured) {
      assertCurrent();
      command.expected = outcome.postimage.version;
      outcome = await execute();
    }
  } catch (cause) {
    if (!captured) {
      if (hasSqliteWorkerOutcomeUnknown(cause)) {
        const error =
          cause instanceof Error
            ? cause
            : new Error("Session actor append outcome is unknown", { cause });
        recordModelFallbackStop(error);
        throw error;
      }
      throw cause;
    }
    return finish(captured, cause);
  }
  if (captured && outcome.kind !== "committed") {
    return finish(captured, new Error("Session actor reply contradicted its captured commit"));
  }
  if (outcome.kind === "unknown") {
    const error = new SqliteWorkerError(outcome.error.message, "outcome-unknown");
    recordModelFallbackStop(error);
    throw error;
  }
  if (outcome.kind === "rolled-back" || outcome.kind === "stale-version") {
    if (outcome.error.name === "SessionTranscriptWriterClaimReboundError") {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    if (outcome.error.name === "SqliteTranscriptMutationConflictError") {
      throw new SqliteTranscriptMutationConflictError(append.input.scope.sessionId);
    }
    throw Object.assign(new Error(outcome.error.message), { name: outcome.error.name });
  }
  return finish(
    outcome,
    outcome.failure &&
      Object.assign(new Error(outcome.failure.message), { name: outcome.failure.name }),
  );

  function finish(committedOutcome: CommittedAppend, cause?: unknown) {
    const committed = committedOutcome.receipt.transcript.append;
    if (!committed) {
      const error = new SqliteWorkerError(
        "Session actor omitted its committed append snapshot",
        "outcome-unknown",
      );
      recordModelFallbackStop(error);
      throw error;
    }
    let failure = cause;
    try {
      admission.publish(committed.value.pendingInputReceipt);
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "Committed append publication failed", {
              cause: failure,
            });
    }
    return {
      committed,
      ...(failure !== undefined
        ? {
            failure: new SessionManagerActorCommittedError(
              committed.kind === "metadata"
                ? "session.metadata.append"
                : "session.transcript.appendMessage",
              { ok: true, value: committed.value },
              failure,
            ),
          }
        : {}),
    };
  }
}
