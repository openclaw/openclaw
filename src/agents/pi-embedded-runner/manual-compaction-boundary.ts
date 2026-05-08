import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../../config/sessions/transcript-store.sqlite.js";
import type { AgentMessage } from "../agent-core-contract.js";
import type { SessionEntry, SessionHeader } from "../transcript/session-transcript-contract.js";
import { TranscriptState } from "../transcript/transcript-state.js";

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

export type HardenedManualCompactionBoundary = {
  applied: boolean;
  firstKeptEntryId?: string;
  leafId?: string;
  messages: AgentMessage[];
  sessionManager?: TranscriptState;
};

function replaceLatestCompactionBoundary(params: {
  entries: SessionEntry[];
  compactionEntryId: string;
}): SessionEntry[] {
  return params.entries.map((entry) => {
    if (entry.type !== "compaction" || entry.id !== params.compactionEntryId) {
      return entry;
    }
    return {
      ...entry,
      // Manual /compact is an explicit checkpoint request, so make the
      // rebuilt context start from the summary itself instead of preserving
      // an upstream "recent tail" that can keep large prior turns alive.
      firstKeptEntryId: entry.id,
    } satisfies CompactionEntry;
  });
}

function entryCreatesCompactionInputMessage(entry: SessionEntry): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

function hasMessagesToSummarizeBeforeKeptTail(params: {
  branch: SessionEntry[];
  compaction: CompactionEntry;
}): boolean {
  const compactionIndex = params.branch.findIndex((entry) => entry.id === params.compaction.id);
  const firstKeptIndex = params.branch.findIndex(
    (entry) => entry.id === params.compaction.firstKeptEntryId,
  );
  if (compactionIndex <= 0 || firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
    return false;
  }

  let boundaryStartIndex = 0;
  for (let i = compactionIndex - 1; i >= 0; i -= 1) {
    const entry = params.branch[i];
    if (entry?.type !== "compaction") {
      continue;
    }
    const previousFirstKeptIndex = params.branch.findIndex(
      (candidate) => candidate.id === entry.firstKeptEntryId,
    );
    boundaryStartIndex = previousFirstKeptIndex >= 0 ? previousFirstKeptIndex : i + 1;
    break;
  }

  return params.branch
    .slice(boundaryStartIndex, firstKeptIndex)
    .some((entry) => entryCreatesCompactionInputMessage(entry));
}

export async function hardenManualCompactionBoundary(params: {
  sessionFile: string;
  preserveRecentTail?: boolean;
}): Promise<HardenedManualCompactionBoundary> {
  const scope = resolveSqliteSessionTranscriptScopeForPath({
    transcriptPath: params.sessionFile,
  });
  if (!scope) {
    throw new Error(
      `Legacy transcript has not been imported into SQLite: ${params.sessionFile}. Run "openclaw doctor --fix" to build the session database.`,
    );
  }
  const events = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  const fileEntries = events.filter((event): event is SessionEntry | SessionHeader =>
    Boolean(event && typeof event === "object"),
  );
  const header = fileEntries.find((entry) => entry?.type === "session") ?? null;
  const entries = fileEntries.filter((entry): entry is SessionEntry => entry?.type !== "session");
  const state = new TranscriptState({ header, entries });
  if (!header) {
    return {
      applied: false,
      messages: [],
      sessionManager: state,
    };
  }

  const leaf = state.getLeafEntry();
  if (leaf?.type !== "compaction") {
    const sessionContext = state.buildSessionContext();
    return {
      applied: false,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
      sessionManager: state,
    };
  }

  const sessionContext = state.buildSessionContext();
  if (params.preserveRecentTail) {
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
      sessionManager: state,
    };
  }

  if (leaf.firstKeptEntryId === leaf.id) {
    return {
      applied: false,
      firstKeptEntryId: leaf.id,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
      sessionManager: state,
    };
  }

  if (
    !leaf.summary.trim() ||
    !hasMessagesToSummarizeBeforeKeptTail({
      branch: state.getBranch(leaf.id),
      compaction: leaf,
    })
  ) {
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  const replacedEntries = replaceLatestCompactionBoundary({
    entries: state.getEntries(),
    compactionEntryId: leaf.id,
  });
  const replacedState = new TranscriptState({
    header,
    entries: replacedEntries,
  });
  replaceSqliteSessionTranscriptEvents({
    ...scope,
    transcriptPath: params.sessionFile,
    events: [header, ...replacedEntries],
  });

  const replacedSessionContext = replacedState.buildSessionContext();
  return {
    applied: true,
    firstKeptEntryId: leaf.id,
    leafId: replacedState.getLeafId() ?? undefined,
    messages: replacedSessionContext.messages,
    sessionManager: replacedState,
  };
}
