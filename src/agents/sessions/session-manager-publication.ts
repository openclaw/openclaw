import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  retainSessionEntryWorkerPublication,
  publishSessionEntryWorkerInvalidations,
} from "../../config/sessions/session-accessor.sqlite-entry-worker-publication.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import {
  parseSessionEntryMetadataReceipts,
  type SessionEntryMetadataReceipt,
} from "../../config/sessions/session-entry-metadata-receipt.js";
import {
  parseSessionTranscriptAuthorityReceipts,
  retainSessionTranscriptWorkerPublication,
  type SessionTranscriptAuthorityReceipt,
} from "../../config/sessions/session-transcript-authority.js";
import type { InitialSessionTranscriptWriter } from "../../config/sessions/transcript-write-context.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";

export type SessionManagerAuthorityPublication = {
  kind: "session-manager-authority";
  transcriptPublication: readonly SessionTranscriptAuthorityReceipt[];
  entryPublication: readonly SessionEntryMetadataReceipt[];
};

export function unwrapSessionManagerPublication(
  request: SqliteWorkerAdmissionRequest,
): SqliteWorkerAdmissionRequest {
  return isRecord(request.facts) && request.facts.kind === "session-manager-authority"
    ? { ...request, facts: request.facts.domainFacts }
    : request;
}

/** Entry and transcript postimages share one native receipt and one observer boundary. */
export function createSessionManagerPublicationHooks(params: {
  agentId: string;
  storePath: string;
  databaseIdentity: string | (() => string | undefined);
  initialWriter?: InitialSessionTranscriptWriter;
  beforeIdentityPublication?: (publication: SessionManagerAuthorityPublication) => void;
}) {
  type Pending = {
    expected?: SessionManagerAuthorityPublication;
    entry?: ReturnType<typeof retainSessionEntryWorkerPublication>;
    transcript?: ReturnType<typeof retainSessionTranscriptWorkerPublication>;
    scope?: { agentId: string; storePath: string; databaseIdentity: string };
  };
  let pending: Pending | undefined;
  return {
    unwrap: unwrapSessionManagerPublication,
    onAdmitted: (request: SqliteWorkerAdmissionRequest) => {
      if (
        request.stage !== "commit" ||
        !isRecord(request.facts) ||
        request.facts.kind !== "session-manager-authority"
      ) {
        return;
      }
      const transcriptPublication = parseSessionTranscriptAuthorityReceipts(
        request.facts.transcriptPublication,
      );
      const entryPublication = parseSessionEntryMetadataReceipts(request.facts.entryPublication);
      const databaseIdentity =
        typeof params.databaseIdentity === "function"
          ? params.databaseIdentity()
          : params.databaseIdentity;
      if (
        !transcriptPublication ||
        !entryPublication ||
        !pending ||
        !databaseIdentity ||
        [...transcriptPublication, ...entryPublication].some(
          (receipt) => receipt.source.identity !== databaseIdentity,
        )
      ) {
        throw new Error("SessionManager commit omitted its authority receipt");
      }
      pending.scope = { agentId: params.agentId, storePath: params.storePath, databaseIdentity };
      pending.expected = {
        kind: "session-manager-authority",
        transcriptPublication,
        entryPublication,
      };
      pending.entry = retainSessionEntryWorkerPublication(pending.scope);
      pending.transcript = retainSessionTranscriptWorkerPublication(pending.scope);
      const unchanged = entryPublication.flatMap((receipt) =>
        [...receipt.facts].flatMap(([key, fact]) =>
          fact.kind === "postimage" && !fact.value.facts.lifecycleChanged ? [key] : [],
        ),
      );
      if (entryPublication.length > 0) {
        pending.entry.beginChanges(
          entryPublication.flatMap((receipt) => Array.from(receipt.facts.keys())),
          new Map(),
          unchanged,
        );
      }
      pending.transcript.begin(transcriptPublication);
    },
    observeAdmission: (
      admission: SqliteWorkerOperationAdmission,
      retained: RetainedWorkerTransactionAdmission,
    ) => {
      const owner: Pending = {};
      pending = owner;
      let committed = false;
      const unknown = () => {
        owner.entry?.settle(undefined, true, owner.transcript?.settle(false, true));
      };
      observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
        if (!isRecord(facts) || facts.kind !== "session-manager-authority") {
          return;
        }
        if (
          !owner.expected ||
          !owner.entry ||
          !owner.transcript ||
          !owner.scope ||
          !isDeepStrictEqual(owner.expected, facts)
        ) {
          unknown();
          throw new Error("SessionManager receipt differs from its admitted postimage");
        }
        const scope = owner.scope;
        const expected = owner.expected;
        const entryPublication = expected.entryPublication;
        committed = true;
        try {
          owner.entry.settleMetadata(
            owner.expected.entryPublication,
            owner.transcript.settle(true, false, owner.expected.transcriptPublication),
            (previous, current) => {
              try {
                params.beforeIdentityPublication?.(expected);
                const initialWriter = params.initialWriter;
                if (initialWriter && !initialWriter.committedFence) {
                  for (const receipt of entryPublication) {
                    for (const fact of receipt.facts.values()) {
                      if (
                        fact.kind === "postimage" &&
                        fact.value.previous === undefined &&
                        fact.value.entry.activeWriterRunId === initialWriter.writerRunId
                      ) {
                        initialWriter.recordCommitted({
                          expectedWriterRunId: initialWriter.writerRunId,
                          expectedLifecycleRevision: fact.value.entry.lifecycleRevision,
                        });
                      }
                    }
                  }
                }
              } finally {
                publishCommittedSessionIdentity(
                  params.agentId,
                  scope.databaseIdentity,
                  previous,
                  current,
                );
              }
            },
          );
        } catch (error) {
          publishSessionEntryWorkerInvalidations(
            owner.scope,
            owner.expected.entryPublication.flatMap((receipt) => Array.from(receipt.facts.keys())),
          );
          const transcript = retainSessionTranscriptWorkerPublication(owner.scope);
          transcript.begin(owner.expected.transcriptPublication);
          sessionChanges.emitBatch(transcript.settle(false, true));
          throw error;
        }
      });
      void retained.settled.then((outcome) => {
        // Drain a queued COMMIT before classifying its native settlement.
        const nativeCommit = admission.committed;
        if (!committed) {
          const rolledBack =
            outcome.kind === "not-entered" ||
            (admission.settlement?.kind === "completed" &&
              nativeCommit === undefined &&
              admission.failureSource !== "protocol");
          owner.entry?.settle(undefined, !rolledBack, owner.transcript?.settle(false, !rolledBack));
        }
        if (pending === owner) {
          pending = undefined;
        }
      });
    },
  };
}
