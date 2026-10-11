import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type {
  AcpSessionMutationCommit,
  AcpSessionMutationDecision,
  AcpSessionMutationPreparation,
  AcpSessionMutationPrepareInput,
} from "./session-meta-write.types.js";

export async function prepareAcpSessionMutation(
  context: ReturnType<typeof captureOpenClawStateWorkerContext>,
  input: Omit<AcpSessionMutationPrepareInput, "nonce">,
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined,
  assertCurrent: () => void,
  authorize?: (stage: "transaction" | "commit") => void,
) {
  const nonce = randomUUID();
  let decision: AcpSessionMutationDecision | undefined;
  const preparation = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "acp.prepareMutation",
        input: { ...input, nonce },
      }),
    {
      assertCurrent,
      createAdmission() {
        let phase: "transaction" | "commit" | "settled" = "transaction";
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          const facts = request.facts;
          assertCurrent();
          if (!isRecord(facts) || facts.nonce !== nonce || request.stage !== phase) {
            throw new Error("ACP callback differs from its retained transaction");
          }
          authorize?.(request.stage === "transaction" ? "transaction" : "commit");
          if (request.stage === "transaction") {
            if (decision) {
              throw new Error("ACP callback has no unique decision");
            }
            // SAFETY: this private worker supplies this operation's authoritative row snapshot.
            const prepared = facts.preparation as AcpSessionMutationPreparation;
            const next = mutate(
              prepared.current,
              prepared.current
                ? mergeSessionEntry(prepared.preparedEntry, { acp: prepared.current })
                : prepared.entry,
            );
            decision =
              next === undefined
                ? { kind: "keep" }
                : next === null
                  ? { kind: "clear" }
                  : { kind: "set", meta: next };
            assertCurrent();
            // Reject uncloneable metadata before any canonical entry mutation.
            structuredClone(decision);
            phase = "commit";
          } else {
            phase = "settled";
          }
          if (!grant()) {
            throw new Error("ACP callback admission expired");
          }
        });
        return {
          nativeLocations: [
            context.admission.databasePath,
            ...("kind" in input.source ? [] : [input.source.path]),
          ],
          admission,
        };
      },
    },
  );

  assertCurrent();
  if (!decision) {
    throw new Error("ACP metadata mutation returned no decision");
  }
  return { preparation, decision };
}

export async function commitAcpSessionMutation(
  context: ReturnType<typeof captureOpenClawStateWorkerContext>,
  input: AcpSessionMutationCommit,
  assertCurrent: () => void,
  authorize?: (stage: "transaction" | "commit") => void,
) {
  if ("kind" in input.source && input.source.kind === "reset" && !authorize) {
    throw new Error("ACP reset publication requires its retained lifecycle guard");
  }
  const nonce = randomUUID();
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  let published = false;
  let pending = false;
  let superseded = false;
  const target = {
    agentId: input.agentId,
    sessionKey: input.sessionKey,
    storePath: input.source.path,
    scope: "acp" as const,
  };
  const invalidation = { ...target, factsInvalidated: true as const };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (
      pending &&
      !published &&
      ("all" in change ||
        (change.sessionKey === input.sessionKey &&
          (!change.agentId || change.agentId === input.agentId)))
    ) {
      superseded = true;
    }
  });
  const publish = () => {
    const receipt = admitted?.admission.committed?.facts;
    if (!published && isRecord(receipt) && receipt.nonce === nonce) {
      published = true;
      try {
        assertCurrent();
      } catch {
        // Commit stays acknowledged, but a retired physical source cannot certify its successor.
        superseded = true;
      }
      // The broker drains committed facts before dispatching the next writer command.
      // A native publication may still supersede this command before its receipt arrives.
      let facts: Extract<SessionRowFacts, { kind: "acp" }> | undefined;
      if (!superseded && isRecord(receipt.facts) && receipt.facts.kind === "acp") {
        // SAFETY: The nonce-bound private worker commit returns this typed ACP postimage.
        facts = receipt.facts as Extract<SessionRowFacts, { kind: "acp" }>;
      }
      sessionChanges.emit(facts ? { ...target, facts } : invalidation);
    }
  };
  try {
    await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        try {
          assertCurrent();
          sessionChanges.invalidate(invalidation);
          await scope.execute({ type: "acp.commitMutation", input: { ...input, nonce } });
        } finally {
          await admitted?.retained.settled;
          publish();
        }
      },
      {
        assertCurrent,
        createAdmission(retained) {
          let phase: "transaction" | "commit" | "settled" = "transaction";
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            assertCurrent();
            if (
              !isRecord(request.facts) ||
              request.facts.nonce !== nonce ||
              request.stage !== phase
            ) {
              throw new Error("ACP metadata commit differs from its retained owner");
            }
            authorize?.(request.stage === "transaction" ? "transaction" : "commit");
            if (request.stage === "transaction") {
              pending = true;
            }
            phase = request.stage === "transaction" ? "commit" : "settled";
            if (!grant()) {
              throw new Error("ACP metadata commit admission expired");
            }
          });
          admitted = { admission, retained };
          observeSqliteWorkerCommittedFacts(admission, publish);
          return {
            nativeLocations: [
              context.admission.databasePath,
              ...("kind" in input.source && input.source.kind !== "reset"
                ? []
                : [input.source.path]),
            ],
            admission,
          };
        },
      },
    );
  } finally {
    try {
      await admitted?.retained.settled;
      publish();
      if (!published) {
        sessionChanges.invalidate(invalidation);
      }
    } finally {
      unsubscribe();
    }
  }
}
