import {
  inputMatchesSessionId,
  matchingEntries,
  selectedClaims,
  selectedOperations,
} from "../../../sessions/session-controller.lifecycle-projections.js";
import { captureSessionWorkRunInterruptions } from "../../../sessions/session-controller.lifecycle.js";
import { hasOperationBackendRunId } from "../../../sessions/session-controller.state.js";
import { captureSessionControllerStop } from "../../../sessions/session-controller.stop.js";
import type { SessionTarget } from "../../../sessions/session-controller.target.js";
import type { SubagentKillInputSnapshot } from "./subagent-control.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Capture physical source and admission owners before descendant discovery can yield. */
export function captureSubagentKillSources(params: {
  target: SessionTarget;
  entry: SubagentRunRecord;
  legacy: boolean;
  sessionId?: string;
  captureQueued: boolean;
}) {
  const { target, entry, legacy, sessionId } = params;
  const stop = captureSessionControllerStop({
    inputs: legacy
      ? matchingEntries(target)
          .flatMap((owner) => owner.mailbox?.entries ?? [])
          .filter((input) => input.protocolRunId === entry.runId)
      : selectedClaims(target).flatMap((claim) =>
          claim.inputs.filter((input) => inputMatchesSessionId(input, sessionId)),
        ),
    operations: [...selectedOperations([target])].filter(
      (operation) =>
        (sessionId === undefined || operation.hasOwnedSessionId(sessionId)) &&
        (!legacy || hasOperationBackendRunId(operation, entry.runId)),
    ),
  });
  const queued: SubagentKillInputSnapshot[] = params.captureQueued
    ? matchingEntries(target).flatMap(
        (owner) =>
          owner.mailbox?.entries
            .filter(
              (input) =>
                !input.claim &&
                input.phase !== "consumed" &&
                inputMatchesSessionId(input, sessionId),
            )
            .map((input) => ({
              input,
              source: input.source,
              target: input.target,
              mailbox: input.mailbox,
            })) ?? [],
      )
    : [];
  const admissions = legacy
    ? captureSessionWorkRunInterruptions({
        scope: target.storeScope,
        identities: [entry.childSessionKey, entry.childSessionIdentity?.sessionId],
        accept: (run) =>
          run.runId === entry.runId &&
          run.sessionKey === entry.childSessionKey &&
          run.agentId === target.agentId &&
          (!entry.childSessionIdentity?.sessionId ||
            run.sessionId === entry.childSessionIdentity.sessionId),
      })
    : [];
  return {
    stop,
    queued,
    admissions,
    cleanup: captureSessionControllerStop({
      inputs: [...stop.inputs, ...queued.map(({ input }) => input)],
      operations: stop.operations,
    }),
    preparation: captureSessionControllerStop({
      inputs: stop.activeInputs.filter((input) => !input.claim?.operation),
    }),
  };
}
