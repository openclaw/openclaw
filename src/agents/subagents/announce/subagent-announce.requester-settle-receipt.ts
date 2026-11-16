import { publishTranscriptUpdate } from "../../../config/sessions/session-accessor.sqlite-events.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentFacts,
} from "../../../config/sessions/session-entry-current.types.js";
import { captureSystemEventStoreCurrentCheck } from "../../../infra/system-event-ownership.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { recordGatewaySessionRunFailure } from "../../../sessions/session-run-error.js";
import { evaluateGatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-context.js";
import type { GatewayToolCallerReceiptAdmission } from "../../tools/gateway-caller-receipt.types.js";
import {
  buildSafeLifecycleErrorMeta,
  subagentRegistryLog,
} from "../registry/subagent-registry-lifecycle-log.js";
import { buildRequesterSettleWakeIdentity } from "../registry/subagent-requester-settle-identity.js";

/** Persist only host-authored copy in the replacement; findings retain their original audience. */
export async function recordRequesterReplacementNotice(params: {
  requester: { canonicalKey: string; agentId?: string; storePath?: string };
  identity: { sessionId: string; lifecycleRevision?: string };
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  assertCommitAllowed: () => void;
}): Promise<boolean> {
  const { runId } = buildRequesterSettleWakeIdentity({
    requesterSessionKey: params.requester.canonicalKey,
    requesterAgentId: params.requester.agentId,
    batchRunIds: params.batchRunIds,
    rearmGeneration: params.rearmGeneration,
  });
  const target = {
    agentId: params.requester.agentId,
    storePath: params.requester.storePath,
    sessionKey: params.requester.canonicalKey,
    sessionId: params.identity.sessionId,
    expectedLifecycleRevision: params.identity.lifecycleRevision,
  };
  try {
    await recordGatewaySessionRunFailure({
      target,
      runId,
      assertCommitAllowed: params.assertCommitAllowed,
      error: "private completion requester session was replaced",
      notice:
        "Subagent results from the previous session were not delivered because a new session was started. Open Tasks to inspect the completed subagents and recover their results.",
    });
    await publishTranscriptUpdate(target, { lifecycleRevision: params.identity.lifecycleRevision });
    return true;
  } catch (error) {
    // Throwing would let the lifecycle caller retire the batch as a failed wake.
    subagentRegistryLog.warn("requester replacement notice could not be persisted", {
      runId,
      error: buildSafeLifecycleErrorMeta(error),
    });
    return false;
  }
}

/** Watch effects retain their original stores; the durable wake keeps its ordinary handoff rules. */
export function createRequesterSettleReceiptAdmission(params: {
  requester: { canonicalKey: string; agentId?: string; storePath?: string };
  identity: { sessionId: string; lifecycleRevision?: string };
  storeSessionKey: string;
  storeAgentId?: string;
  storePaths(): readonly (string | null | undefined)[];
  isSourceCurrent(): boolean;
  readCurrent(): SessionEntryCurrentFacts | undefined;
  isStoreCurrent(): boolean;
}) {
  const isEntryCurrent = (entry: SessionEntryCurrentFacts | undefined) =>
    entry?.sessionId === params.identity.sessionId &&
    entry.lifecycleRevision === params.identity.lifecycleRevision &&
    params.isSourceCurrent();
  const admission: GatewayToolCallerReceiptAdmission = {
    async prepare() {
      const storeCurrent = captureSystemEventStoreCurrentCheck(
        params.storeSessionKey,
        params.storeAgentId,
      );
      const [
        { withSessionEntryReadOnlyInWorker },
        { captureSessionEntryCurrentRead, captureNativeSessionEntryCurrentRead },
      ] = await Promise.all([
        import("../../../config/sessions/session-entry-read-runtime.js"),
        import("../../../config/sessions/session-entry-current-runtime.js"),
      ]);
      const scope = {
        sessionKey: params.requester.canonicalKey,
        agentId: params.requester.agentId,
        storePath: params.requester.storePath,
        projection: "list" as const,
      };
      const bind = (
        current: CapturedSessionEntryCurrentRead,
        entry: SessionEntryCurrentFacts | undefined,
      ) => {
        let currentEntry = entry;
        const isCurrent = () => {
          try {
            current.assertSourceCurrent();
            return (
              params.storePaths().every(storeCurrent) &&
              isEntryCurrent(current.kind === "file" ? currentEntry : current.readCurrent())
            );
          } catch {
            return false;
          }
        };
        return {
          current: {
            sources: current.kind === "file" ? [current.source] : [],
            assertCurrent(entries: readonly (SessionEntryCurrentFacts | undefined)[]) {
              if (current.kind === "file") {
                currentEntry = entries[0];
              }
              if (!isCurrent()) {
                throw new Error("Requester settle authority changed during watch admission");
              }
            },
          },
          isCurrent,
        };
      };
      if (isIncognitoSessionKey(scope.sessionKey)) {
        return bind(captureNativeSessionEntryCurrentRead(scope), undefined);
      }
      return withSessionEntryReadOnlyInWorker(
        scope,
        () => {},
        async (read, owner) => {
          if (!read.ok) {
            throw read.error;
          }
          return bind(captureSessionEntryCurrentRead(scope, owner), read.value);
        },
      );
    },
  };
  return Object.assign(admission, {
    isRequesterCurrent: () => {
      try {
        return evaluateGatewayToolCallerReceiptAdmission(admission, () =>
          isEntryCurrent(params.readCurrent()),
        );
      } catch {
        return false;
      }
    },
    isStoreCurrent: () =>
      evaluateGatewayToolCallerReceiptAdmission(admission, () => params.isStoreCurrent()),
  });
}
