import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  resolveMemorySessionTargetsAsync,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  type MemoryEntryOrigin,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import {
  borrowOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import { DREAMS_FILENAMES } from "./dreaming-dreams-file.js";
import {
  readSessionIngestionState,
  writeSessionIngestionState,
} from "./dreaming-ingestion-state.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  selectedMemoryLineageIdentity,
  type MemoryForgetLineageResult,
} from "./memory-entry-origins-task.js";
import { listMemoryEntryOrigins } from "./memory-entry-origins.js";
import {
  PROMOTION_MARKER,
  referencesSession,
  scrubMemoryContent,
} from "./memory-forget-content.js";
import { collectTranscriptWrites } from "./memory-forget-curated-writes.js";
import { planMemoryIndex } from "./memory-forget-index-sources.js";
import { summarizeParticipantMatches, type MemoryForgetReport } from "./memory-forget-report.js";
import { withMemoryForgetWorker } from "./memory-forget-worker.js";
import {
  listWorkspaceDirectory,
  listWorkspaceMemoryFiles,
  readWorkspaceText,
} from "./memory-workspace-files.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";
import { SESSION_CORPUS_RELATIVE_DIR } from "./session-ingestion.js";
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
  targets: Awaited<ReturnType<typeof resolveMemorySessionTargetsAsync>>;
  databaseOptions: Parameters<typeof withOpenClawAgentDatabaseWrite>[0];
  database?: ReturnType<typeof borrowOpenClawAgentDatabase>;
  origins?: MemoryEntryOrigin[];
  selectedEntryKeys: Set<string>;
  tombstoned: boolean;
};

type MemoryForgetAttempt = { kind: "complete"; report: MemoryForgetReport } | { kind: "reprepare" };

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
      targets: await resolveMemorySessionTargetsAsync({
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
  const allOrigins =
    context.origins ??
    (await listMemoryEntryOrigins({ agentId: params.agentId }, context.databaseOptions));
  for (const origin of allOrigins) {
    if (sessionIds.has(origin.sessionId)) {
      context.selectedEntryKeys.add(origin.entryKey);
    }
  }
  const entryKeys = new Set(context.selectedEntryKeys);
  const lineageIdentity = selectedMemoryLineageIdentity(allOrigins, sessionIds, entryKeys);
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
    listSessionTranscriptCorpusEntriesForAgent(params.agentId, {
      readOnly: true,
      includeContentRevision: false,
    }),
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
  const indexPlan = await planMemoryIndex(
    {
      agentId: params.agentId,
      changedPaths,
      removedPaths: new Set(
        corpusRewrites.filter((rewrite) => rewrite.remove).map((rewrite) => rewrite.relativePath),
      ),
      sessionIds,
      excludedSessionIds,
      entryKeys,
      corpusSnippets,
    },
    context.databaseOptions,
  );
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
  const acceptLineage = (lineage: MemoryForgetLineageResult): boolean => {
    if (lineage.current) {
      return true;
    }
    // Keep observed selected keys even if another workspace later removes their rows.
    context.origins = lineage.origins;
    return false;
  };
  const chunkIds = indexPlan.chunks.map((chunk) => chunk.id);
  const extensionPath =
    chunkIds.length > 0 && indexPlan.hasVectorTable
      ? expectDefined(indexPlan.extensionPath, "memory forget vector preparation")
      : undefined;
  const lineage = {
    agentId: params.agentId,
    sessionIds: [...sessionIds],
    entryKeys: [...entryKeys],
    identity: lineageIdentity,
  };
  const purged = await withMemoryForgetWorker(
    context.databaseOptions,
    db,
    { kind: "forget", prepareTombstones: !context.tombstoned, extensionPath },
    async (scope) => {
      if (!context.tombstoned) {
        const marked = await scope.execute({ type: "forget.mark", input: lineage });
        if (!acceptLineage(marked)) {
          return false;
        }
        context.tombstoned = true;
      }
      // The marker has committed. A purge failure must leave it durable for retry.
      return acceptLineage(
        await scope.execute({
          type: "forget.purge",
          input: {
            ...lineage,
            chunkIds,
            sources: indexPlan.sources,
            hasVectorTable: indexPlan.hasVectorTable,
          },
        }),
      );
    },
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
  await withMemoryForgetWorker(
    context.databaseOptions,
    db,
    { kind: "forget", prepareTombstones: false },
    (scope) =>
      scope.execute({
        type: "delete",
        input: { agentId: params.agentId, entryKeys: [...entryKeys] },
      }),
  );
  return { kind: "complete", report };
}
