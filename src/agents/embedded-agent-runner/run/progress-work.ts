import { isDeepStrictEqual } from "node:util";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { captureSessionActorStorageOwner } from "../../../config/sessions/session-actor-storage-binding.js";
import { assertSessionEntryCohortScope } from "../../../config/sessions/session-entry-cohort-scope.js";
import { captureSessionEntryNativeMutationWitness } from "../../../config/sessions/session-entry-read-ordered.js";
import { prepareSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { prepareSessionTranscriptHydration } from "../../../config/sessions/session-transcript-hydration.js";
import { withSessionHistoryWorkerDatabase } from "../../../config/sessions/session-transcript-worker-runtime.js";
import type { SessionTranscriptCurrentTurnEntryRequest } from "../../../config/sessions/session-transcript-worker.types.js";
import {
  captureSessionTranscriptTargetBinding,
  type CapturedSessionTranscriptTargetBinding,
} from "../../../config/sessions/transcript-target-binding.js";
import { getAgentRunLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import { readSqliteDatabaseWriteTokenForPath } from "../../../infra/sqlite-database-admission.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import type {
  WorkSnapshot,
  WorkCoverage,
} from "../../../session-cards/progress-card-work-intent.js";
import type {
  ProgressOwner,
  WorkRecord,
  ProgressWorkState,
} from "../../../session-cards/progress-card-work.js";
import type { ReplyOperation } from "../../../sessions/session-controller.contracts.js";
import {
  getReplyOperationSessionReader,
  getReplyOperationSessionTarget,
} from "../../../sessions/session-controller.session-reader.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";

// Complete host transcript calls/results plus writer-admitted native invocation facts
// establish settled reads. Unknown/delegated effects never use map emptiness as proof.
async function observeCoverage(
  target: CapturedSessionTranscriptTargetBinding,
  record: WorkRecord,
  signal?: AbortSignal,
  observe?: (
    assertHistoryCurrent: () => Promise<void>,
    query: SessionTranscriptCurrentTurnEntryRequest,
  ) => void,
): Promise<WorkCoverage> {
  const unavailable = (reason: string): WorkCoverage => ({ kind: "unavailable", reason });
  if (record.source.processGeneration !== getAgentRunLifecycleGeneration()) {
    return unavailable("Native process/lifecycle changed");
  }
  const hydration = prepareSessionTranscriptHydration(
    target,
    { maxBytes: 262_144, maxEvents: 256 },
    signal,
  );
  const prepared = await hydration.read();
  hydration.assertCurrent();
  if (
    prepared.kind !== "bounded" ||
    prepared.snapshot.truncated ||
    !prepared.snapshot.completeActivePath
  ) {
    return unavailable("Incomplete bounded execution history");
  }
  const { version, activeLeafEntryId } = prepared.snapshot;
  observe?.(
    async () => {
      if (!activeLeafEntryId) {
        throw new Error("Missing active history leaf");
      }
      const latest = await hydration.readCurrentTurnEntry({
        entryId: activeLeafEntryId,
        version,
        includeEntry: true,
      });
      hydration.assertCurrent();
      if (
        !isDeepStrictEqual(latest.version, version) ||
        (latest.anchor?.entryId !== activeLeafEntryId &&
          asOptionalObjectRecord(latest.event)?.id !== activeLeafEntryId)
      ) {
        throw new Error("Execution history changed during final work observation");
      }
    },
    { entryId: activeLeafEntryId ?? "", version, includeEntry: true },
  );
  let anchored = false;
  const pending = new Map<
    string,
    { sourceEntryId: string; runId: string; turnId: string; toolName: string }
  >();
  const seen = new Set<string>();
  for (const entry of prepared.snapshot.events) {
    const event = asOptionalObjectRecord(entry);
    if (anchored && event?.type === "reset") {
      return unavailable("Session reset requires current explicit reconciliation");
    }
    const message = asOptionalObjectRecord(event?.message);
    if (!message) {
      continue;
    }
    const metadata = asOptionalObjectRecord(message["__openclaw"]);
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const calls = content.map(asOptionalObjectRecord).filter((part) => part?.type === "toolCall");
      if (!anchored) {
        if (
          metadata?.runId !== record.source.runId ||
          (message.responseId || message.turnId) !== record.source.turnId ||
          !calls.some((call) => call?.id === record.source.toolCallId)
        ) {
          continue;
        }
        anchored = true;
      }
      for (const call of calls) {
        if (
          typeof call?.id !== "string" ||
          typeof call.name !== "string" ||
          typeof event?.id !== "string" ||
          typeof metadata?.runId !== "string" ||
          typeof (message.responseId || message.turnId) !== "string" ||
          seen.has(call.id)
        ) {
          return unavailable("Malformed or repeated tool invocation prevents native coverage");
        }
        seen.add(call.id);
        pending.set(call.id, {
          sourceEntryId: event.id,
          runId: metadata.runId,
          turnId: String(message.responseId || message.turnId),
          toolName: call.name,
        });
      }
    } else if (anchored && message.role === "toolResult") {
      const source =
        typeof message.toolCallId === "string" ? pending.get(message.toolCallId) : undefined;
      const fact = asOptionalObjectRecord(metadata?.nativeInvocation);
      if (
        !source ||
        !fact ||
        message.isError ||
        fact.v !== 1 ||
        fact.entryId !== event?.id ||
        !isDeepStrictEqual(fact.owner, record.owner) ||
        fact.sourceEntryId !== source.sourceEntryId ||
        fact.runId !== source.runId ||
        metadata?.runId !== source.runId ||
        fact.turnId !== source.turnId ||
        fact.toolCallId !== message.toolCallId ||
        fact.toolName !== source.toolName ||
        message.toolName !== source.toolName ||
        fact.processGeneration !== record.source.processGeneration ||
        (fact.qualification !== "read" && fact.qualification !== "managed-progress")
      ) {
        return unavailable("Unaccounted or unqualified native invocation in execution interval");
      }
      pending.delete(String(message.toolCallId));
    } else if (anchored && message.role !== "user" && message.role !== "custom") {
      return unavailable("Unknown execution record in bounded interval");
    } else if (
      anchored &&
      message.role === "custom" &&
      typeof message.customType === "string" &&
      message.customType.includes("nested-tool")
    ) {
      return unavailable("Delegated execution interval needs native observation");
    }
  }
  return anchored && pending.size === 0
    ? { kind: "covered", basis: "bounded-no-handoff" }
    : unavailable("Missing work-source anchor or unresolved invocation");
}

/** Capture the admitted physical owner once; refresh never reroutes by current config. */
export function captureProgressWorkReader(input: {
  target: CapturedSessionTranscriptTargetBinding & { expectedLifecycleRevision?: string | null };
  operation?: ReplyOperation;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const reader = getReplyOperationSessionReader(input.operation);
  const selected = getReplyOperationSessionTarget(input.operation);
  const target = captureSessionTranscriptTargetBinding(
    selected ? { ...input.target, ...selected } : input.target,
  );
  const owner: ProgressOwner = {
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleRevision: target.expectedLifecycleRevision ?? null,
  };
  if (reader) {
    assertSessionEntryCohortScope(reader, target);
  }
  const namespace = isIncognitoSessionKey(target.sessionKey)
    ? captureSessionActorStorageOwner(target, {
        assertCurrent: input.assertCurrent,
        authorize: input.assertCurrent,
      })
    : undefined;
  const assertMemoryCurrent = namespace?.owner?.captureSessionReadGuard(target.sessionKey);
  const assertCurrent = () => {
    input.signal?.throwIfAborted();
    input.assertCurrent();
    reader?.assertCurrent();
    assertMemoryCurrent?.();
    namespace?.authority.assertCurrent();
  };
  return {
    owner,
    async read(): Promise<WorkSnapshot> {
      try {
        assertCurrent();
        const resolvedDatabase =
          reader?.database ??
          (!isIncognitoSessionKey(target.sessionKey)
            ? await prepareSqliteTargetFromSessionStorePath(
                target.storePath,
                {
                  agentId: target.agentId,
                  env: target.env,
                },
                input.signal,
              )
            : undefined);
        assertCurrent();
        if (resolvedDatabase && !resolvedDatabase.agentId) {
          throw new Error("Retained work physical database owner unavailable");
        }
        const database = resolvedDatabase?.agentId
          ? { ...resolvedDatabase, agentId: resolvedDatabase.agentId, env: target.env }
          : undefined;
        const readWork = async (): Promise<ProgressWorkState | undefined> => {
          let work: ProgressWorkState | undefined;
          if (isIncognitoSessionKey(target.sessionKey)) {
            const actor = namespace?.owner
              ? await namespace.owner.acquireExisting(owner.sessionKey, {
                  assertCurrent,
                  assertReadable: assertCurrent,
                })
              : namespace?.binding?.actor;
            if (!actor?.storage || !namespace) {
              throw new Error("Retained memory owner unavailable");
            }
            try {
              const entry = await actor.storage.read(
                { type: "session.entry.read", input: { sessionKey: owner.sessionKey } },
                namespace.authority,
              );
              if (
                entry?.sessionId !== owner.sessionId ||
                (entry.lifecycleRevision ?? null) !== owner.lifecycleRevision ||
                entry.archivedAt !== undefined
              ) {
                throw new Error("Retained work incarnation changed");
              }
              work = await actor.storage.read(
                { type: "progressCard.work", input: { sessionKey: owner.sessionKey } },
                namespace.authority,
              );
            } finally {
              if (namespace.owner) {
                await actor.release();
              }
            }
          } else {
            if (!database) {
              throw new Error("Retained work database unavailable");
            }
            work = await withSessionHistoryWorkerDatabase(database, (openedDatabase) =>
              openedDatabase.readProgressWork({ owner, env: target.env }, input.signal),
            );
          }
          assertCurrent();
          return work;
        };
        const work = await readWork();
        if (!work) {
          return { kind: "none" };
        }
        if (work.record && !isDeepStrictEqual(work.record.owner, owner)) {
          throw new Error("Retained work owner changed");
        }
        let assertHistoryCurrent: (() => Promise<void>) | undefined;
        let historyQuery: SessionTranscriptCurrentTurnEntryRequest | undefined;
        const coverage = work.record
          ? await observeCoverage(target, work.record, input.signal, (verify, query) => {
              assertHistoryCurrent = verify;
              historyQuery = query;
            }).catch((): WorkCoverage => ({
              kind: "unavailable",
              reason: "Execution observation failed",
            }))
          : undefined;
        assertCurrent();
        // Coverage awaited another owner. Recheck the exact semantic fence before
        // publishing it; a replacement or reset cannot inherit the old interval.
        const finalize = async (): Promise<WorkSnapshot> => {
          const assertNative = database
            ? captureSessionEntryNativeMutationWitness([database])
            : undefined;
          const before = database && readSqliteDatabaseWriteTokenForPath(database.path);
          const latest = await readWork();
          assertCurrent();
          if (!latest) {
            return { kind: "none" };
          }
          if (latest.generation !== work.generation || latest.revision !== work.revision) {
            return {
              kind: "retained",
              state: latest,
              coverage: {
                kind: "unavailable",
                reason: "Retained work changed during execution observation",
              },
            };
          }
          if (coverage?.kind === "covered") {
            try {
              if (!assertHistoryCurrent) {
                throw new Error("Missing native history observation");
              }
              await assertHistoryCurrent();
              assertCurrent();
              assertNative?.();
              if (
                database &&
                (!before || before !== readSqliteDatabaseWriteTokenForPath(database.path))
              ) {
                throw new Error("Retained storage changed during final observation");
              }
              // Memory storage supplies synchronous current reads from the captured owner.
              if (namespace) {
                const query = {
                  type: "progressCard.work" as const,
                  input: { sessionKey: owner.sessionKey },
                };
                const current = namespace.owner
                  ? namespace.owner.readStorage(owner.sessionKey, query, namespace.authority)
                  : namespace.binding?.actor.storage?.readCurrent(query, namespace.authority);
                if (
                  !current ||
                  current.generation !== latest.generation ||
                  current.revision !== latest.revision
                ) {
                  throw new Error("Retained work changed during final history observation");
                }
                if (!historyQuery) {
                  throw new Error("Missing final history query");
                }
                const history = {
                  type: "session.history.current-turn-entry" as const,
                  input: { ...historyQuery, sessionId: owner.sessionId },
                };
                const currentHistory = namespace.owner
                  ? namespace.owner.readStorage(owner.sessionKey, history, namespace.authority)
                  : namespace.binding?.actor.storage?.readCurrent(history, namespace.authority);
                if (
                  !isDeepStrictEqual(currentHistory?.version, historyQuery.version) ||
                  (currentHistory?.anchor?.entryId !== historyQuery.entryId &&
                    asOptionalObjectRecord(currentHistory?.event)?.id !== historyQuery.entryId)
                ) {
                  throw new Error("Execution history changed after awaited final read");
                }
              }
            } catch {
              return {
                kind: "retained",
                state: latest,
                coverage: {
                  kind: "unavailable",
                  reason: "Execution history changed during final work observation",
                },
              };
            }
          }
          return { kind: "retained", state: latest, coverage };
        };
        return database
          ? await runOpenClawAgentWriteAdmission(
              database,
              finalize,
              true,
              undefined,
              input.signal,
              "history.hydration",
            )
          : await finalize();
      } catch {
        return { kind: "unavailable", reason: "Retained work owner/read unavailable" };
      }
    },
  };
}

export function progressWorkTurnContext(snapshot: WorkSnapshot): string {
  if (snapshot.kind === "none") {
    return "";
  }
  if (snapshot.kind === "unavailable") {
    return (
      "Retained task observation unavailable: " +
      snapshot.reason +
      ". Do not infer completion or replay effects."
    );
  }
  const record = snapshot.state.record;
  if (!record) {
    return "";
  }
  return (
    "Retained task context (observation, not new authority): " +
    JSON.stringify({
      scope: record.scope,
      steps: record.steps,
      disposition: record.disposition,
      coverage: snapshot.coverage,
      generation: snapshot.state.generation,
      revision: snapshot.state.revision,
    }) +
    ". Follow current instructions; preserve completed effects. Unavailable observation never authorizes resubmission, completion or resume."
  );
}
