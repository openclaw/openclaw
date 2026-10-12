import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import type { SessionTranscriptBoundedActiveContext } from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
  loadTranscriptEventsFromDatabase,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTranscriptReadScope } from "../../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { findSessionTranscriptHeader } from "../../config/sessions/session-entry-codec.js";
import { resolveSqliteSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { prepareSessionManagerHydration } from "./session-manager-incognito.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
  SessionManagerPersistenceTarget,
  SessionManagerTranscriptCohort,
} from "./session-manager-view-types.js";

/** Both open paths capture, hydrate, and construct under the same source and truncation rules. */
export async function openSessionManagerBoundedView<T extends object>(
  target: SessionTranscriptRuntimeTarget,
  options: SessionManagerBoundedContextLimits & {
    cwd?: string;
    onTruncated?: () => void;
    signal?: AbortSignal;
  },
  create: (
    cwd: string,
    target: SessionManagerPersistenceTarget,
    context: SessionTranscriptBoundedActiveContext,
    limits: SessionManagerBoundedContextLimits,
  ) => T,
  cohort?: {
    selection: SessionManagerTranscriptCohort["selection"];
    consume: (
      manager: T,
      ...prepared: Parameters<SessionManagerTranscriptCohort["consume"]>
    ) => void;
    captureView: (manager: T) => object;
  },
): Promise<T> {
  const { cwd, onTruncated, signal, ...limits } = options;
  const fallbackCwd = cwd ?? process.cwd();
  const hydration = prepareSessionManagerHydration(target, { limits, signal });
  const assertOwned = captureOwnedTranscriptWriteAssertion(hydration.target);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertOwned();
    hydration.assertCurrent();
  };
  const publish = (prepared: PreparedSessionTranscriptReload) => {
    assertCurrent();
    if (prepared.kind !== "bounded") {
      throw new Error("Expected a bounded transcript snapshot");
    }
    const context = prepared.snapshot;
    if (context.truncated) {
      onTruncated?.();
    }
    assertCurrent();
    const header = findSessionTranscriptHeader(context.events);
    const manager = create(cwd ?? header?.cwd ?? fallbackCwd, hydration.target, context, limits);
    if (cohort) {
      consumeSessionManagerReload(
        prepared,
        (snapshot, assertView) => cohort.consume(manager, snapshot, assertView),
        () => cohort.captureView(manager),
        assertCurrent,
      );
    }
    return manager;
  };
  assertCurrent();
  if (cohort) {
    if (!hydration.readCohort) {
      throw new Error("Initial transcript cohorts require their durable history owner");
    }
    let manager: T | undefined;
    await hydration.readCohort(cohort.selection, (prepared) => {
      manager = publish(prepared);
    });
    if (!manager) {
      throw new Error("Initial transcript cohort did not publish its manager");
    }
    return manager;
  }
  return publish(
    await hydration.read().catch((error: unknown) => {
      // Typed absence must not hide a revoked owner.
      assertOwned();
      throw error;
    }),
  );
}

export function consumeSessionManagerReload(
  prepared: PreparedSessionTranscriptReload,
  consume: SessionManagerTranscriptCohort["consume"] | undefined,
  captureView: () => object,
  assertCurrent: () => void,
): void {
  const adopted = captureView();
  const consumed = consume?.(prepared, () => {
    assertCurrent();
    const current = captureView();
    if (
      Object.keys(adopted).some((key) => Reflect.get(adopted, key) !== Reflect.get(current, key))
    ) {
      throw new Error("Session manager changed after transcript cohort adoption");
    }
  });
  if (isPromiseLike(consumed)) {
    void Promise.resolve(consumed).catch(() => {});
    throw new Error("Transcript cohort consumers must remain synchronous");
  }
}

export function readSessionManagerReload(
  target: SessionTranscriptRuntimeTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
  ignoreReadFence: boolean,
  transaction?: OpenClawAgentDatabase,
): PreparedSessionTranscriptReload {
  if (transaction && !transaction.db.isTransaction) {
    throw new Error("Session reload lost its borrowed transaction");
  }
  if (limits) {
    return {
      kind: "bounded",
      snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
        ...limits,
        ...(ignoreReadFence ? { ignoreReadFence: true } : {}),
        transaction,
      }),
    };
  }
  if (transaction) {
    const resolved = resolveSqliteTranscriptReadScope(target);
    const fence = ignoreReadFence
      ? undefined
      : resolveSqliteSessionTranscriptReadFence({ database: transaction, ...resolved });
    return {
      kind: "full",
      snapshot: {
        events: loadTranscriptEventsFromDatabase(transaction, resolved.sessionId, {
          beforeEventSeq: fence?.beforeRawSeq,
        }),
        version: readTranscriptContextVersionInTransaction(transaction, resolved.sessionId),
      },
    };
  }
  if (!ignoreReadFence) {
    return { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target) };
  }
  const { events, snapshot } = inspectTranscriptEventsSync(target);
  return {
    kind: "full",
    snapshot: {
      events,
      version: {
        generation: snapshot.generation,
        rawSeq: snapshot.lastSeq,
        updatedAt: snapshot.transcriptUpdatedAt,
      },
    },
  };
}
