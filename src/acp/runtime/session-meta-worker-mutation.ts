import { randomUUID } from "node:crypto";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { IncognitoSessionActor } from "../../config/sessions/session-incognito-actor.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { captureAcpSessionEntryBinding } from "./session-meta-entry.kernel.js";
import type { AcpSessionEntryMutation } from "./session-meta-entry.types.js";
import type {
  IncognitoAcpSessionMutation,
  IncognitoAcpSessionParams,
} from "./session-meta-incognito.types.js";
import { buildAcpDatabaseSessionKey } from "./session-meta-keys.js";
import { readAcpSessionMetaForEntries } from "./session-meta-readonly.js";
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
          const port =
            isRecord(facts) && facts.preparationPort instanceof MessagePort
              ? facts.preparationPort
              : undefined;
          try {
            assertCurrent();
            if (!isRecord(facts) || facts.nonce !== nonce || request.stage !== phase) {
              throw new Error("ACP callback differs from its retained transaction");
            }
            authorize?.(request.stage === "transaction" ? "transaction" : "commit");
            if (request.stage === "transaction") {
              if (!port || decision) {
                throw new Error("ACP callback has no unique decision port");
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
              port.postMessage(decision, []);
              phase = "commit";
            } else {
              phase = "settled";
            }
            if (!grant()) {
              throw new Error("ACP callback admission expired");
            }
          } finally {
            port?.close();
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
  const nonce = randomUUID();
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  let published = false;
  const publish = () => {
    const receipt = admitted?.admission.committed?.facts;
    if (!published && isRecord(receipt) && receipt.nonce === nonce) {
      published = true;
      sessionChanges.emit({ agentId: input.agentId, sessionKey: input.sessionKey });
    }
  };
  try {
    await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        try {
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
            phase = request.stage === "transaction" ? "commit" : "settled";
            if (!grant()) {
              throw new Error("ACP metadata commit admission expired");
            }
          });
          admitted = { admission, retained };
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
  } finally {
    await admitted?.retained.settled;
    publish();
  }
}

type Target = IncognitoAcpSessionParams & {
  actor: IncognitoSessionActor;
};

function captureTarget(params: Target) {
  const { actor, authority } = params;
  const sessionKey = params.sessionKey.trim().toLowerCase();
  const context = captureOpenClawStateWorkerContext({ env: params.env, path: params.databasePath });
  const assertCurrent = () => {
    actor.assertCurrent();
    authority.assertCurrent();
    context.admission.assertCurrent();
  };
  assertCurrent();
  if (
    !isIncognitoSessionKey(sessionKey) ||
    actor.path !==
      resolveIncognitoOpenClawAgentSqlitePath({ agentId: actor.agentId, env: context.environment })
  ) {
    throw new Error("ACP incognito access differs from its retained actor");
  }
  return { actor, authority, sessionKey, context, assertCurrent };
}

/** Inactive join: volatile entry custody spans the existing shared metadata reader. */
export function readIncognitoAcpSessionEntry(params: Target): Promise<SessionEntry | undefined> {
  const { actor, authority, sessionKey, context, assertCurrent } = captureTarget(params);
  return actor.sessions.withSharedState(async () => {
    const { entry, claim } = await actor.sessions.read(authority, { sessionKey });
    const snapshot = actor.sessions.captureSnapshot(sessionKey);
    const [acp] = await readAcpSessionMetaForEntries({
      entries: [{ sessionKey, agentId: actor.agentId, entry }],
      cfg: params.cfg,
      env: context.environment,
      databasePath: context.admission.databasePath,
    });
    assertCurrent();
    snapshot.assertCurrent();
    claim.authorize(authority, "commit");
    if (!entry) {
      return undefined;
    }
    delete entry.acp;
    return acp ? { ...entry, acp } : entry;
  });
}

/** Preserve entry → shared metadata ordering without holding an actor grant across a second owner. */
export function upsertIncognitoAcpSessionMeta(
  params: Target & IncognitoAcpSessionMutation,
): Promise<SessionEntry | null> {
  const { actor, authority, sessionKey, context, assertCurrent } = captureTarget(params);
  const expectedControlBinding =
    params.expectedControlBinding && structuredClone(params.expectedControlBinding);
  const updatedAt = params.now?.() ?? Date.now();
  const metadataRead = {
    keys: [buildAcpDatabaseSessionKey(sessionKey, actor.agentId)],
  };
  return actor.sessions.withSharedState(async () => {
    const readSource = async () => {
      const { snapshot, claim } = await actor.sessions.acpSource(authority, sessionKey);
      const retained = actor.sessions.captureSnapshot(sessionKey);
      return {
        source: {
          kind: "ephemeral" as const,
          agentId: actor.agentId,
          path: actor.path,
          identity: actor.identity,
          snapshot,
        },
        assertCurrent(this: void) {
          assertCurrent();
          retained.assertCurrent();
        },
        authorize(this: void, stage: "transaction" | "commit") {
          claim.authorize(authority, stage);
        },
      };
    };
    const initial = await readSource();
    const entry = initial.source.snapshot.entry;
    const { preparation, decision } = await prepareAcpSessionMutation(
      context,
      {
        read: { ...metadataRead, entry },
        entry,
        updatedAt,
        source: initial.source,
        sessionKey,
        agentId: actor.agentId,
        expectedControlBinding,
      },
      params.mutate,
      initial.assertCurrent,
      initial.authorize,
    );
    initial.assertCurrent();
    initial.authorize("commit");
    if (decision.kind === "keep") {
      return preparation.current
        ? mergeSessionEntry(entry, { acp: preparation.current })
        : (entry ?? null);
    }
    const update = async (
      mutation: AcpSessionEntryMutation,
      expectedEntry: SessionEntry | undefined,
    ) => {
      // Row predicates are transaction-local. A pending actor projection cannot grant its own write.
      const result = await actor.sessions.sideData(authority, {
        type: "session.acp.entry",
        input: {
          agentId: actor.agentId,
          sessionKey,
          mutation,
          expectedEntry: expectedEntry ? captureAcpSessionEntryBinding(expectedEntry) : null,
          expectedControlBinding,
        },
      });
      assertCurrent();
      return result.entry;
    };
    const changed =
      decision.kind === "clear"
        ? entry
          ? await update({ kind: "clear" }, entry)
          : null
        : await update(
            { kind: "touch", updatedAt, fallbackEntry: preparation.preparedEntry },
            entry,
          );
    if (decision.kind === "set" && !changed) {
      return null;
    }
    const commitEntry = changed ?? entry;
    const publication = await readSource();
    await commitAcpSessionMutation(
      context,
      {
        agentId: actor.agentId,
        storageSessionKey: sessionKey,
        sessionKey,
        entry: commitEntry,
        currentRowKey: preparation.currentRowKey,
        currentRowSessionId: preparation.currentRowSessionId,
        updatedAt,
        decision,
        source: publication.source,
        expectedControlBinding,
      },
      publication.assertCurrent,
      publication.authorize,
    );
    publication.assertCurrent();
    publication.authorize("commit");
    if (decision.kind === "clear") {
      return changed;
    }
    return mergeSessionEntry(changed ?? undefined, { acp: decision.meta });
  });
}
