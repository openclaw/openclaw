import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  resolveMemorySessionTargets,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  loadSqliteVecExtension,
  readMemoryEntryOriginsInDatabase,
  type MemoryEntryOrigin,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import {
  borrowOpenClawAgentDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  resolveOpenClawAgentSqlitePath,
  runSqliteImmediateTransactionSync,
  tableExists,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import { DREAMS_FILENAMES } from "./dreaming-dreams-file.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  deleteMemoryEntryOriginsInDatabase,
  listMemoryEntryOrigins,
  recordMemorySessionTombstonesInDatabase,
} from "./memory-entry-origins.js";
import { collectTranscriptWrites } from "./memory-forget-curated-writes.js";
import {
  deleteMemoryIndexSources,
  planMemoryIndex,
  referencesSession,
  type ForgetDatabase,
} from "./memory-forget-index-sources.js";
import { summarizeParticipantMatches, type MemoryForgetReport } from "./memory-forget-report.js";
import { ensureMemorySessionTombstones } from "./memory-session-tombstones.js";
import {
  listWorkspaceDirectory,
  listWorkspaceMemoryFiles,
  readWorkspaceText,
} from "./memory-workspace-files.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";
import {
  readSessionIngestionState,
  SESSION_CORPUS_RELATIVE_DIR,
  writeSessionIngestionState,
} from "./session-ingestion.js";
import { commitMemoryContent, hashMemoryContent } from "./short-term-promotion-memory-write.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";

type MemoryRewrite = {
  absolutePath: string;
  relativePath: string;
  content: string;
  remove: boolean;
  expectedContent: string;
};
const PROMOTION_MARKER = /^\s*<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->\s*$/u;
const LINEAGE_MARKER = /^\s*<!--\s*openclaw-memory-lineage:[^\n]*?-->\s*$/u;

function scrubMemoryContent(params: {
  content: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  corpusSnippets: ReadonlySet<string>;
  agentId: string;
}): { content: string; removedEntries: number; removedLines: number } {
  // Preserve surviving line endings so unrelated artifacts do not enter the purge plan.
  const lines = params.content.split("\n");
  const corpusSnippets = [...params.corpusSnippets];
  let removedEntries = 0;
  let removedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const markerKey = PROMOTION_MARKER.exec(lines[index] ?? "")?.[1]?.trim();
    if (markerKey && params.entryKeys.has(markerKey)) {
      const start = index > 0 && LINEAGE_MARKER.test(lines[index - 1] ?? "") ? index - 1 : index;
      let end = index + 1;
      if (end < lines.length && !PROMOTION_MARKER.test(lines[end] ?? "")) {
        end += 1;
        while (end < lines.length && /^\s+\S/u.test(lines[end] ?? "")) {
          end += 1;
        }
      }
      lines.splice(start, end - start);
      removedEntries += 1;
      index = start - 1;
      continue;
    }
    if (corpusSnippets.some((snippet) => lines[index]?.includes(snippet))) {
      lines.splice(index, 1);
      removedLines += 1;
      index -= 1;
      continue;
    }
    if (!referencesSession(lines[index] ?? "", params.agentId, params.sessionIds)) {
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(lines[index] ?? "");
    const rowIndent = /^(\s*)[-*+]\s/u.exec(lines[index] ?? "")?.[1]?.length;
    if (!heading && !/\bSession ID:/iu.test(lines[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = /^(#{1,6})\s/u.exec(lines[end] ?? "");
      if (
        (rowIndent !== undefined && (lines[end] ?? "").search(/\S/u) <= rowIndent) ||
        (nextHeading && (!heading || nextHeading[1]!.length <= heading[1]!.length)) ||
        /\bSession ID:/iu.test(lines[end] ?? "")
      ) {
        break;
      }
      end += 1;
    }
    lines.splice(index, end - index);
    removedEntries += 1;
    index -= 1;
  }
  return { content: lines.join("\n"), removedEntries, removedLines };
}

type MemoryForgetParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionIds?: string[];
  hookSources?: string[];
  participants?: string[];
  since?: string;
  dryRun?: boolean;
};

type MemoryForgetContext = {
  targets: ReturnType<typeof resolveMemorySessionTargets>;
  databaseOptions: Parameters<typeof withOpenClawAgentDatabaseWrite>[0];
  database?: ReturnType<typeof borrowOpenClawAgentDatabase>;
  origins?: MemoryEntryOrigin[];
  selectedEntryKeys: Set<string>;
  tombstoned: boolean;
};

type MemoryForgetAttempt = { kind: "complete"; report: MemoryForgetReport } | { kind: "reprepare" };

function selectedLineageIdentity(
  origins: readonly MemoryEntryOrigin[],
  sessionIds: ReadonlySet<string>,
  entryKeys: ReadonlySet<string>,
): string {
  // Selected sessions and every contributor to their entries determine the purge.
  return JSON.stringify(
    origins
      .filter((origin) => sessionIds.has(origin.sessionId) || entryKeys.has(origin.entryKey))
      .map(({ entryKey, sessionId }) => [entryKey, sessionId]),
  );
}

export async function forgetMemoryEntries(params: MemoryForgetParams): Promise<MemoryForgetReport> {
  if (!params.sessionIds?.length && !params.hookSources?.length && !params.participants?.length) {
    throw new Error("memory forget requires a session, hook source, or participant selector");
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const run = async (): Promise<MemoryForgetReport> => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: resolveStateDir(process.env) };
    const databaseOptions = {
      agentId: params.agentId,
      env,
      path: resolveOpenClawAgentSqlitePath({ agentId: params.agentId, env }),
    };
    const context: MemoryForgetContext = {
      targets: resolveMemorySessionTargets({
        agentId: params.agentId,
        storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId }),
        sessionIds: params.sessionIds,
        hookSources: params.hookSources,
        participants: params.participants,
        since: params.since,
      }),
      databaseOptions,
      selectedEntryKeys: new Set(),
      tombstoned: false,
    };
    try {
      for (;;) {
        const result = await forgetWorkspaceMemory(params, workspaceDir, context);
        if (result.kind === "complete") {
          return result.report;
        }
      }
    } finally {
      context.database?.release();
    }
  };
  // Replanning retains this workspace owner and, once acquired, its exact database borrow.
  return params.dryRun ? run() : withMemoryWorkspaceLock(workspaceDir, run);
}

async function forgetWorkspaceMemory(
  params: MemoryForgetParams,
  workspaceDir: string,
  context: MemoryForgetContext,
): Promise<MemoryForgetAttempt> {
  const targets = context.targets;
  const sessionIds = new Set(targets.map((target) => target.sessionId));
  const allOrigins = context.origins ?? listMemoryEntryOrigins({ agentId: params.agentId });
  for (const origin of allOrigins) {
    if (sessionIds.has(origin.sessionId)) {
      context.selectedEntryKeys.add(origin.entryKey);
    }
  }
  const entryKeys = new Set(context.selectedEntryKeys);
  const lineageIdentity = selectedLineageIdentity(allOrigins, sessionIds, entryKeys);
  const allOriginKeys = new Set([...entryKeys, ...allOrigins.map((origin) => origin.entryKey)]);
  const mixedLineageEntryKeys = new Set(
    allOrigins
      .filter((origin) => entryKeys.has(origin.entryKey) && !sessionIds.has(origin.sessionId))
      .map((origin) => origin.entryKey),
  );
  const untargetableEntryKeys = new Set<string>();
  const refusals: string[] = [];
  const corpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const corpusFiles = await listWorkspaceDirectory(workspaceDir, corpusDir).catch(
    (error: unknown) => {
      if (isFileMissingError(error)) {
        return [];
      }
      throw error;
    },
  );
  const corpusRewrites: MemoryRewrite[] = [];
  const corpusSnippets = new Set<string>();
  let removedCorpusLines = 0;
  for (const file of corpusFiles) {
    if (!file.isFile() || !/\.(?:txt|md)$/iu.test(file.name)) {
      continue;
    }
    const absolutePath = path.join(corpusDir, file.name);
    const content = await readWorkspaceText(workspaceDir, absolutePath);
    const lines = content.split("\n");
    const retained = lines.filter((line) => {
      if (!referencesSession(line, params.agentId, sessionIds)) {
        return true;
      }
      const snippet = /^\[[^\]]+#L\d+\]\s*(.+)$/u.exec(line.trimEnd())?.[1]?.trim();
      // Ingestion only admits snippets of at least 12 characters; shorter
      // malformed corpus rows must never trigger broad substring deletion.
      if (snippet && snippet.length >= 12) {
        corpusSnippets.add(snippet);
      }
      return false;
    });
    if (retained.length !== lines.length) {
      removedCorpusLines += lines.length - retained.length;
      const rewritten = retained.join("\n");
      corpusRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: rewritten,
        remove: rewritten.trim().length === 0,
        expectedContent: content,
      });
    }
  }

  const memoryRewrites: MemoryRewrite[] = [];
  const scrub = (content: string) =>
    scrubMemoryContent({ content, entryKeys, sessionIds, corpusSnippets, agentId: params.agentId });
  let removedMemoryEntries = 0;
  let removedMemoryLines = 0;
  const memoryFiles = await listWorkspaceMemoryFiles(
    workspaceDir,
    DREAMS_FILENAMES.map((name) => path.join(workspaceDir, name)),
  );
  for (const absolutePath of memoryFiles) {
    // Corpus evidence must survive until every dependent artifact is clean.
    if (path.dirname(absolutePath) === corpusDir) {
      continue;
    }
    const content = await readWorkspaceText(workspaceDir, absolutePath);
    for (const line of content.split(/\r?\n/u)) {
      const key = PROMOTION_MARKER.exec(line)?.[1]?.trim();
      if (key && !allOriginKeys.has(key)) {
        untargetableEntryKeys.add(key);
      }
    }
    const scrubbed = scrub(content);
    if (/^## Memory Consolidation History\r?$[\s\S]*^ {2}- `[+-] /mu.test(scrubbed.content)) {
      refusals.push(
        `Cannot trace historical consolidation highlights in ${path.relative(workspaceDir, absolutePath)}; review them manually.`,
      );
    }
    if (scrubbed.content !== content) {
      memoryRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: scrubbed.content,
        remove: false,
        expectedContent: content,
      });
      removedMemoryEntries += scrubbed.removedEntries;
      removedMemoryLines += scrubbed.removedLines;
    }
  }

  const nowIso = new Date().toISOString();
  const [
    shortTermEntries,
    phaseSignals,
    ingestionState,
    backups,
    artifactProvenance,
    sessionCorpusEntries,
  ] = await Promise.all([
    readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
    }),
    readPhaseSignalStore(workspaceDir, nowIso),
    readSessionIngestionState(workspaceDir),
    readMemoryPreimages(workspaceDir),
    listMemoryArtifactProvenance({ workspaceDir }),
    listSessionTranscriptCorpusEntriesForAgent(params.agentId),
  ]);
  const sessionKeys = new Set(targets.map((target) => target.sessionKey));
  const curatedWrites = new Map(
    artifactProvenance
      .filter(({ provenance }) =>
        provenance.sessionId
          ? sessionIds.has(provenance.sessionId)
          : Boolean(provenance.sessionKey && sessionKeys.has(provenance.sessionKey)),
      )
      .map(({ relativePath, provenance }) => [
        relativePath,
        { relativePath, observedAt: provenance.observedAt },
      ]),
  );
  const retainedShortTerm = shortTermEntries.filter(
    ({ key, value }) =>
      !entryKeys.has(key) &&
      !entryKeys.has(value.key) &&
      !referencesSession(`${value.path}\n${value.snippet}`, params.agentId, sessionIds),
  );
  const retainedShortTermSet = new Set(retainedShortTerm);
  const removedShortTermKeys = new Set(
    shortTermEntries
      .filter((entry) => !retainedShortTermSet.has(entry))
      .flatMap(({ key, value }) => [key, value.key]),
  );
  const removedPhaseSignalKeys = Object.keys(phaseSignals.entries).filter(
    (key) => entryKeys.has(key) || removedShortTermKeys.has(key),
  );
  const retainedSeenMessages = Object.entries(ingestionState.seenMessages).filter(
    ([scope]) => !referencesSession(scope, params.agentId, sessionIds),
  );
  const removedSeenScopes =
    Object.keys(ingestionState.seenMessages).length - retainedSeenMessages.length;
  const retainedFileStates = Object.fromEntries(
    Object.entries(ingestionState.files).filter(
      ([key]) => !referencesSession(key, params.agentId, sessionIds),
    ),
  );
  let rewrittenBackups = 0;
  const nextBackups = backups.map(({ key, value }) => {
    const scrubbed = scrub(value.content);
    if (scrubbed.content === value.content) {
      return { key, value };
    }
    rewrittenBackups += 1;
    return {
      key,
      value: {
        ...value,
        content: scrubbed.content,
        contentHash: hashMemoryContent(scrubbed.content),
      },
    };
  });

  const excludedSessionIds = new Set<string>();
  for (const entry of sessionCorpusEntries) {
    const selectedSession = sessionIds.has(entry.sessionId);
    if (!isMemorySessionIndexable(entry)) {
      excludedSessionIds.add(entry.sessionId);
      if (!selectedSession) {
        continue;
      }
    }
    if (
      selectedSession ||
      (entry.artifactKind === "archive-artifact" &&
        (!entry.sessionKind || entry.sessionKind === "unknown"))
    ) {
      const parsed = await buildSessionEntry(entry.sessionFile, {
        ...(entry.transcriptSource === "sqlite"
          ? { agentId: entry.agentId, sessionId: entry.sessionId, storePath: entry.storePath }
          : {}),
        ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
        ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
        ...(selectedSession
          ? {
              onTranscriptMessage: (message: unknown, observedAt: number) =>
                collectTranscriptWrites({
                  message,
                  observedAt,
                  workspaceDir,
                  writes: curatedWrites,
                }),
            }
          : {}),
      });
      if (parsed && !isMemorySessionIndexable(parsed)) {
        excludedSessionIds.add(entry.sessionId);
      }
    }
  }

  const changedPaths = new Set(
    [...memoryRewrites, ...corpusRewrites].map((rewrite) => rewrite.relativePath),
  );
  const indexPlan = await planMemoryIndex({
    agentId: params.agentId,
    changedPaths,
    removedPaths: new Set(
      corpusRewrites.filter((rewrite) => rewrite.remove).map((rewrite) => rewrite.relativePath),
    ),
    sessionIds,
    excludedSessionIds,
    matchesMemory: (content) => scrub(content).content !== content,
  });
  const report: MemoryForgetReport = {
    agentId: params.agentId,
    dryRun: params.dryRun === true,
    sessionIds: [...sessionIds].toSorted(),
    participantMatches: summarizeParticipantMatches(targets, params.participants),
    sessionResolutions: targets
      .map(({ sessionId, sessionKey, resolution }) =>
        sessionKey
          ? { sessionId, sessionKey, source: resolution }
          : { sessionId, source: resolution },
      )
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId)),
    entryKeys: [...entryKeys].toSorted(),
    mixedLineageEntryKeys: [...mixedLineageEntryKeys].toSorted(),
    untargetableEntryKeys: [...untargetableEntryKeys].toSorted(),
    curatedWrites: [...curatedWrites.values()].toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    artifacts: {
      memoryFiles: memoryRewrites.length,
      memoryEntries: removedMemoryEntries,
      memoryLines: removedMemoryLines,
      sessionCorpusFiles: corpusRewrites.length,
      sessionCorpusLines: removedCorpusLines,
      indexChunks: indexPlan.chunks.length,
      indexSources: indexPlan.sources.length,
      ftsRows: indexPlan.ftsRows,
      vectorRows: indexPlan.vectorRows,
      embeddingCacheRows: indexPlan.embeddingCacheRows,
      shortTermEntries: shortTermEntries.length - retainedShortTerm.length,
      seenHashScopes: removedSeenScopes,
      backups: rewrittenBackups,
      originRows: allOrigins.filter((origin) => entryKeys.has(origin.entryKey)).length,
    },
    refusals,
  };
  if (params.dryRun || sessionIds.size === 0) {
    return { kind: "complete", report };
  }

  context.database ??= await withOpenClawAgentDatabaseWrite(context.databaseOptions, () =>
    borrowOpenClawAgentDatabase(context.databaseOptions),
  );
  const { db } = context.database;
  const lineageIsCurrent = () => {
    const origins = tableExists(db, "memory_entry_origins")
      ? readMemoryEntryOriginsInDatabase(db, { agentId: params.agentId })
      : [];
    if (selectedLineageIdentity(origins, sessionIds, entryKeys) === lineageIdentity) {
      return true;
    }
    // Keep observed selected keys even if another workspace later removes their rows.
    context.origins = origins;
    for (const origin of origins) {
      if (sessionIds.has(origin.sessionId)) {
        context.selectedEntryKeys.add(origin.entryKey);
      }
    }
    return false;
  };
  const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
  const chunkIds = indexPlan.chunks.map((chunk) => chunk.id);
  if (chunkIds.length > 0 && indexPlan.hasVectorTable) {
    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      throw new Error(`memory forget cannot purge vector index: ${loaded.error ?? "load failed"}`);
    }
  }

  const purged = await withOpenClawAgentDatabaseWrite(
    context.databaseOptions,
    () => {
      if (!context.tombstoned) {
        // Prepare additive schema before the guarded transaction: its cache must
        // not survive a rollback that also removes the newly created table.
        ensureMemorySessionTombstones(db);
        const marked = runSqliteImmediateTransactionSync(db, () => {
          if (!lineageIsCurrent()) {
            return false;
          }
          const recorded = recordMemorySessionTombstonesInDatabase(db, {
            agentId: params.agentId,
            sessionIds: [...sessionIds],
          });
          if (recorded === 0) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("memory_index_state")
                .set((expression) => ({ revision: expression("revision", "+", 1) }))
                .where("id", "=", 1),
            );
          }
          return true;
        });
        if (!marked) {
          return false;
        }
        context.tombstoned = true;
      }
      // The marker has committed. A purge failure must leave it durable for retry.
      return runSqliteImmediateTransactionSync(db, () => {
        if (!lineageIsCurrent()) {
          return false;
        }
        if (chunkIds.length > 0) {
          if (indexPlan.hasVectorTable) {
            executeSqliteQuerySync(
              db,
              kysely.deleteFrom("memory_index_chunks_vec").where("id", "in", chunkIds),
            );
          }
          executeSqliteQuerySync(
            db,
            kysely.deleteFrom("memory_index_chunks").where("id", "in", chunkIds),
          );
        }
        deleteMemoryIndexSources(db, indexPlan.sources);
        if (tableExists(db, "memory_embedding_cache")) {
          executeSqliteQuerySync(db, kysely.deleteFrom("memory_embedding_cache"));
        }
        return true;
      });
    },
    db,
  );
  if (!purged) {
    return { kind: "reprepare" };
  }
  if (removedPhaseSignalKeys.length > 0) {
    for (const key of removedPhaseSignalKeys) {
      delete phaseSignals.entries[key];
    }
    phaseSignals.updatedAt = nowIso;
    // Phase signals are derived from recall rows. Remove them first so a
    // later failure leaves the authoritative recall evidence for a retry.
    await writePhaseSignalStore(workspaceDir, phaseSignals);
  }
  if (retainedShortTerm.length !== shortTermEntries.length) {
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      entries: retainedShortTerm,
    });
  }
  if (
    removedSeenScopes > 0 ||
    Object.keys(retainedFileStates).length !== Object.keys(ingestionState.files).length
  ) {
    await writeSessionIngestionState(workspaceDir, {
      ...ingestionState,
      files: retainedFileStates,
      seenMessages: Object.fromEntries(retainedSeenMessages),
    });
  }
  if (rewrittenBackups > 0) {
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir,
      entries: nextBackups,
    });
  }
  for (const rewrite of [...memoryRewrites, ...corpusRewrites]) {
    await commitMemoryContent({
      workspaceDir,
      filePath: rewrite.absolutePath,
      tempPrefix: `${path.basename(rewrite.absolutePath)}.forget`,
      expectedHash: hashMemoryContent(rewrite.expectedContent),
      expectedContent: rewrite.expectedContent,
      allowInPlaceFallback: true,
      conflictMessage: `${path.basename(rewrite.absolutePath)} changed before the memory forget rewrite could commit`,
      content: rewrite.remove ? null : rewrite.content,
    });
  }
  await withOpenClawAgentDatabaseWrite(
    context.databaseOptions,
    () =>
      deleteMemoryEntryOriginsInDatabase(db, {
        agentId: params.agentId,
        entryKeys: [...entryKeys],
      }),
    db,
  );
  return { kind: "complete", report };
}
