import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.js";
import { persistCompactionBoundaryWithSessionEntryAsync } from "../../config/sessions/session-accessor.sqlite-compaction-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  resolveMaxActiveTranscriptBytes,
  refreshTranscriptByteCompactionLatch,
} from "../../context-engine/transcript-byte-limit.js";
import { readSessionTranscriptAccountingAsync } from "../../gateway/session-transcript-readers.js";
import { SessionEntryCommittedError } from "../sessions/session-manager-persistence-error.js";
import type { QueuedCompactionHostOptions } from "./compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

/** Apply the ordinary turn's host byte budget before an explicit native compaction. */
export async function prepareManualTranscriptByteCompaction(
  params: CompactEmbeddedAgentSessionParams,
  host: QueuedCompactionHostOptions,
  target: SessionTranscriptRuntimeTarget,
  initialEntry: SessionEntry | undefined,
  selectedHarnessRuntime: string | undefined,
): Promise<{ params: CompactEmbeddedAgentSessionParams; host: QueuedCompactionHostOptions }> {
  const maxBytes = resolveMaxActiveTranscriptBytes(params.config);
  let entry = initialEntry;
  if (
    params.trigger !== "manual" ||
    !entry ||
    selectedHarnessRuntime !== "codex" ||
    maxBytes === undefined
  ) {
    return { params, host };
  }
  const { byteSize: activeBytes } = await readSessionTranscriptAccountingAsync(
    target,
    { includeByteSize: true, includeUsage: false },
    params.abortSignal,
  );
  params.abortSignal?.throwIfAborted();
  host.assertActive?.();
  const latch = entry.transcriptByteCompactionLatch;
  const refreshedLatch = refreshTranscriptByteCompactionLatch(
    latch,
    entry.sessionId,
    maxBytes,
    activeBytes,
  );
  if (refreshedLatch !== latch) {
    const sessionStore = { [target.sessionKey]: entry };
    const count = await incrementCompactionCount({
      ...target,
      sessionStore,
      amount: 0,
      expectedSession: entry,
      transcriptByteCompactionLatch: refreshedLatch,
      authorize: () => {
        params.abortSignal?.throwIfAborted();
        host.assertActive?.();
        return true;
      },
    });
    params.abortSignal?.throwIfAborted();
    host.assertActive?.();
    if (count === undefined) {
      throw new Error("Session changed before byte-compaction progress could be refreshed");
    }
    entry = sessionStore[target.sessionKey] ?? entry;
  }
  if (activeBytes === undefined || activeBytes < maxBytes || refreshedLatch !== undefined) {
    return { params, host };
  }
  // Native compaction leaves the host mirror unchanged. Repair the same budget
  // the next ordinary turn checks before completing the explicit native request.
  return {
    params: { ...params, preflightRequired: true, preflightCompactionTrigger: "transcript_bytes" },
    host: createCompactionAccounting({
      target,
      entry,
      byteBudget: { activeBytes, maxBytes },
      host: { ...host, transcriptBytePreflightHarness: "codex" },
    }).host,
  };
}

/** Accounts host commits inside the compaction lane, including commits followed by cancellation. */
export function createCompactionAccounting(params: {
  target: SessionTranscriptRuntimeTarget;
  entry: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  byteBudget?: { activeBytes: number; maxBytes: number };
  host: QueuedCompactionHostOptions;
}) {
  const byteBudget = params.byteBudget;
  let entry = params.entry;
  let committed = false;
  const store = params.sessionStore ?? { [params.target.sessionKey]: entry };
  const record = async (
    acceptedEntry: SessionEntry,
    tokensAfter: number | undefined,
    compactionKind: EmbeddedAgentCompactResult["compactionKind"],
    amount = 1,
  ) => {
    let postCompactionBytes: number | undefined;
    if (byteBudget) {
      try {
        postCompactionBytes = (
          await readSessionTranscriptAccountingAsync(
            { ...params.target, sessionId: acceptedEntry.sessionId },
            { includeByteSize: true, includeUsage: false },
          )
        ).byteSize;
      } catch {
        // Preserve the atomic boundary's latch when the post-commit read is unavailable.
        postCompactionBytes = byteBudget.activeBytes;
      }
    }
    const maxBytes = byteBudget?.maxBytes;
    const count = await incrementCompactionCount({
      ...params.target,
      sessionStore: store,
      amount,
      tokensAfter,
      compactionKind,
      expectedSession: acceptedEntry,
      authorize: () => {
        params.host.assertActive?.();
        return true;
      },
      transcriptByteCompactionLatch:
        postCompactionBytes !== undefined &&
        maxBytes !== undefined &&
        postCompactionBytes >= maxBytes
          ? { sessionId: acceptedEntry.sessionId, activeBytes: postCompactionBytes, maxBytes }
          : undefined,
    });
    if (count === undefined) {
      throw new Error("Session changed before compaction maintenance could be recorded");
    }
    entry = store[params.target.sessionKey] ?? acceptedEntry;
    committed = true;
  };
  const host: QueuedCompactionHostOptions = {
    ...params.host,
    ...(params.host.transcriptBytePreflightHarness && byteBudget
      ? {
          withCompactionPersistenceAsync: async (prepared) => {
            const result = await persistCompactionBoundaryWithSessionEntryAsync(
              {
                ...params.target,
                sessionId: entry.sessionId,
                expectedLifecycleRevision: entry.lifecycleRevision,
                expectedWriterRunId: entry.activeWriterRunId,
                expectedOwner: {
                  lifecycleRevision: entry.lifecycleRevision,
                  activeWriterRunId: entry.activeWriterRunId,
                },
              },
              {
                prepared,
                transcriptByteCompactionLatch: { sessionId: entry.sessionId, ...byteBudget },
              },
              () => params.host.assertActive?.(),
            ).catch((error: unknown) => {
              if (error instanceof SessionEntryCommittedError) {
                committed = true;
              }
              throw error;
            });
            committed = true;
            return result;
          },
        }
      : {}),
    onCommitted: (accepted) => {
      entry = accepted.entry;
      store[params.target.sessionKey] = accepted.entry;
      params.host.onCommitted?.(accepted);
    },
    onHostCompactionCommitted: async (commit) => {
      await record(commit.entry, commit.tokensAfter, commit.compactionKind, committed ? 0 : 1);
      await params.host.onHostCompactionCommitted?.({
        ...commit,
        entry,
        accountingCommitted: true,
      });
    },
    onHostCompactionTranscriptSettled: async (commit) => {
      if (params.host.transcriptBytePreflightHarness && byteBudget) {
        await record(commit.entry, undefined, undefined, 0);
      }
      await params.host.onHostCompactionTranscriptSettled?.({
        ...commit,
        entry,
        accountingCommitted: true,
      });
    },
  };
  return {
    host,
    record,
    get entry() {
      return entry;
    },
    get committed() {
      return committed;
    },
  };
}
