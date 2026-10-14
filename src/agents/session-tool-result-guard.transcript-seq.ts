import type { SessionManager } from "./sessions/index.js";

function resolveEntryTranscriptSeq(
  sessionManager: SessionManager,
  entryId: string | null | undefined,
  seqByEntryId: Map<string, number>,
): number | undefined {
  if (!entryId) {
    return 0;
  }
  const cached = seqByEntryId.get(entryId);
  if (cached !== undefined) {
    return cached;
  }
  let seq = 0;
  for (const entry of sessionManager.getBranch(entryId)) {
    if (entry.type === "message" || entry.type === "compaction") {
      seq += 1;
    }
    seqByEntryId.set(entry.id, seq);
  }
  return seqByEntryId.get(entryId);
}

export function resolveAppendedMessageSeq(params: {
  sessionManager: SessionManager;
  entryId: unknown;
  parentEntryId: string | null | undefined;
  seqByEntryId: Map<string, number>;
}): number | undefined {
  if (typeof params.entryId !== "string") {
    return undefined;
  }
  const parentSeq = resolveEntryTranscriptSeq(
    params.sessionManager,
    params.parentEntryId,
    params.seqByEntryId,
  );
  if (parentSeq === undefined) {
    return undefined;
  }
  const messageSeq = parentSeq + 1;
  params.seqByEntryId.set(params.entryId, messageSeq);
  return messageSeq;
}
