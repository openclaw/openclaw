import { resolveMaxActiveTranscriptBytes } from "../../auto-reply/reply/memory-flush.js";
import { incrementCompactionCount } from "../../auto-reply/reply/session-updates.js";
import {
  persistCompactionBoundaryWithSessionEntrySync,
  readSessionTranscriptActiveStats,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { QueuedCompactionHostOptions } from "./compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "./compact.types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

export function hasMatchingTranscriptByteCompactionLatch(
  entry: SessionEntry,
  activeBytes: number,
  maxBytes: number,
): boolean {
  const latch = entry.transcriptByteCompactionLatch;
  return (
    latch?.sessionId === entry.sessionId &&
    latch.maxBytes === maxBytes &&
    activeBytes >= maxBytes &&
    activeBytes - latch.activeBytes < maxBytes
  );
}

/** Apply the ordinary turn's host byte budget before an explicit native compaction. */
export function prepareManualTranscriptByteCompaction(
  params: CompactEmbeddedAgentSessionParams,
  host: QueuedCompactionHostOptions,
  target: SessionTranscriptRuntimeTarget,
  entry: SessionEntry | undefined,
  selectedHarnessRuntime: string | undefined,
): { params: CompactEmbeddedAgentSessionParams; host: QueuedCompactionHostOptions } {
  const maxBytes = resolveMaxActiveTranscriptBytes(params.config);
  if (
    params.trigger !== "manual" ||
    !entry ||
    selectedHarnessRuntime !== "codex" ||
    maxBytes === undefined
  ) {
    return { params, host };
  }
  const { sizeBytes: activeBytes } = readSessionTranscriptActiveStats(target);
  if (
    activeBytes < maxBytes ||
    hasMatchingTranscriptByteCompactionLatch(entry, activeBytes, maxBytes)
  ) {
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
        postCompactionBytes = readSessionTranscriptActiveStats({
          ...params.target,
          sessionId: acceptedEntry.sessionId,
        }).sizeBytes;
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
          withCompactionPersistence: (prepared) => {
            params.host.assertActive?.();
            const result = persistCompactionBoundaryWithSessionEntrySync(
              {
                ...params.target,
                sessionId: entry.sessionId,
                expectedLifecycleRevision: entry.lifecycleRevision,
                expectedWriterRunId: entry.activeWriterRunId,
              },
              {
                prepared,
                transcriptByteCompactionLatch: {
                  sessionId: entry.sessionId,
                  ...byteBudget,
                },
              },
            );
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
