import path from "node:path";
import { resolveSessionAgentId } from "../../../../src/agents/agent-scope.js";
import { parseUsageCountedSessionIdFromFileName } from "../../../../src/config/sessions/artifacts.js";
import { canonicalizeMainSessionAlias } from "../../../../src/config/sessions/main-session.js";
import { listSessionEntriesReadOnly } from "../../../../src/config/sessions/session-accessor.sqlite-entry-list.read.js";
import { readTranscriptStatsBatchReadOnlySync } from "../../../../src/config/sessions/session-accessor.sqlite-transcript-stats-read.js";
import type { CanonicalSessionReaderContinuation } from "../../../../src/config/sessions/session-canonical-key.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../../../../src/config/sessions/session-history-read.js";
import type { SessionEntry } from "../../../../src/config/sessions/types.js";
import {
  classifySessionEntry,
  collectCronGeneratedSessionKeys,
} from "./session-transcript-corpus-policy.js";
import type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
  SessionTranscriptCorpusArtifact,
} from "./session-transcript-corpus.types.js";

function sqliteContentRevision(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath: string;
}): string | undefined {
  try {
    const stats = readTranscriptStatsBatchReadOnlySync([params])[0];
    if (!stats) {
      return undefined;
    }
    return [
      "sqlite",
      stats.maxSeq,
      stats.sizeBytes,
      stats.eventCount,
      stats.lastMutationAtMs ?? "",
      stats.lastObservedMutationAtMs ?? "",
    ].join(":");
  } catch {
    return undefined;
  }
}

type SessionEntrySummary = {
  sessionKey: string;
  entry: SessionEntry;
};

function toArtifactCorpusEntry(
  agentId: string,
  artifactPath: string,
  sessionId: string,
  primaryEntry?: SessionTranscriptCorpusEntry,
  contentRevision?: string,
): SessionTranscriptCorpusEntry {
  return {
    agentId,
    artifactKind: "archive-artifact",
    sessionFile: artifactPath,
    sessionId,
    ...(contentRevision ? { contentRevision } : {}),
    ...(primaryEntry?.generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
    ...(primaryEntry?.generatedByCronRun ? { generatedByCronRun: true } : {}),
    sessionKind: primaryEntry?.sessionKind ?? "unknown",
  };
}

function projectSessionTranscriptCorpusEntries(
  scope: SessionTranscriptCorpusScope,
  options: SessionTranscriptCorpusOptions,
  artifacts: readonly SessionTranscriptCorpusArtifact[],
  sessionEntries: readonly SessionEntrySummary[],
  databasePath = scope.storePath,
  continuation?: CanonicalSessionReaderContinuation,
): SessionTranscriptCorpusEntry[] {
  const { cfg, env, normalizedAgentId, storePath, isSharedFixedStore } = scope;
  const includeContentRevision = options.includeContentRevision !== false;
  const activeEntriesBySessionId = new Map<string, SessionTranscriptCorpusEntry>();
  const entryOwnersBySessionId = new Map<string, string>();
  const instanceScope = {
    agentId: normalizedAgentId,
    env,
    hydrateSkillPromptRefs: false,
    projection: "list",
    readConsistency: "latest",
    storePath: databasePath,
  } satisfies Parameters<typeof listSessionTranscriptInstances>[0];
  const retainedInstances = options.includeRetainedSqlite
    ? listSessionTranscriptInstances(instanceScope, {}, continuation)
    : [];
  const retainedInstanceIds = new Set(retainedInstances.map((instance) => instance.sessionId));
  const activeSessionIdsToRead = [
    ...new Set(
      sessionEntries.flatMap(({ entry }) => {
        const sessionId = entry.sessionId?.trim();
        return sessionId && !retainedInstanceIds.has(sessionId) ? [sessionId] : [];
      }),
    ),
  ];
  const ownershipInstances = [
    ...retainedInstances,
    ...(activeSessionIdsToRead.length > 0
      ? listSessionTranscriptInstances(
          instanceScope,
          { includeAllWindows: true, sessionIds: activeSessionIdsToRead },
          continuation,
        )
      : []),
  ];
  // Current metadata can lose a captured owner, but cannot establish ownership of
  // transcript bytes that predate provenance capture. Use each window's recorded facts.
  const pluginOwnersBySessionId = new Map<string, string>();
  for (const instance of ownershipInstances) {
    if (instance.provenanceKnown && instance.entry.pluginOwnerId) {
      pluginOwnersBySessionId.set(instance.sessionId, instance.entry.pluginOwnerId);
    }
  }
  const archivedIdentitiesByName = new Map(
    listSessionTranscriptArchivesReadOnly({
      agentId: normalizedAgentId,
      env,
      archiveNames: artifacts.map((artifact) => path.basename(artifact.path)),
      storePath: databasePath,
    }).map((archive) => [archive.archiveName, archive]),
  );
  const cronGeneratedSessionKeys = collectCronGeneratedSessionKeys([
    ...retainedInstances.map(({ entry, sessionKey }) => ({ entry, sessionKey })),
    ...sessionEntries,
  ]);
  const toSqliteEntry = (
    agentId: string,
    sessionId: string,
    sessionKey: string,
    entry: SessionEntry,
    artifactKind: "active-session" | "retained-session",
    updatedAtMs?: number,
  ): SessionTranscriptCorpusEntry => {
    const classification = classifySessionEntry(sessionKey, entry, cronGeneratedSessionKeys);
    const transcriptKey = artifactKind === "active-session" ? sessionKey.trim() : sessionKey;
    const pluginOwnerId = pluginOwnersBySessionId.get(sessionId);
    const contentRevision = includeContentRevision
      ? sqliteContentRevision({
          agentId,
          env,
          sessionId,
          ...(transcriptKey ? { sessionKey: transcriptKey } : {}),
          storePath: databasePath,
        })
      : undefined;
    return {
      agentId,
      artifactKind,
      sessionFile: transcriptKey,
      sessionId,
      ...(contentRevision ? { contentRevision } : {}),
      transcriptSource: "sqlite",
      storePath,
      ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
      ...(transcriptKey ? { sessionKey: transcriptKey } : {}),
      ...(pluginOwnerId ? { pluginOwnerId } : {}),
      ...(classification.generatedByDreamingNarrative
        ? { generatedByDreamingNarrative: true }
        : {}),
      ...(classification.generatedByCronRun ? { generatedByCronRun: true } : {}),
      sessionKind: classification.sessionKind,
    };
  };
  const resolveSessionOwnership = (key: string) => {
    const sessionKey = isSharedFixedStore
      ? key
      : canonicalizeMainSessionAlias({
          cfg,
          agentId: normalizedAgentId,
          sessionKey: key,
        });
    const ownerAgentId = resolveSessionAgentId({
      config: cfg,
      sessionKey,
      ...(isSharedFixedStore ? {} : { fallbackAgentId: normalizedAgentId }),
    });
    return { sessionKey, ownerAgentId };
  };
  for (const summary of sessionEntries) {
    const { ownerAgentId } = resolveSessionOwnership(summary.sessionKey);
    const sessionId = summary.entry.sessionId?.trim();
    if (!sessionId) {
      continue;
    }
    const entry = toSqliteEntry(
      ownerAgentId,
      sessionId,
      summary.sessionKey,
      summary.entry,
      "active-session",
      Number.isFinite(summary.entry.updatedAt) ? summary.entry.updatedAt : undefined,
    );
    entryOwnersBySessionId.set(entry.sessionId, ownerAgentId);
    if (ownerAgentId === normalizedAgentId) {
      activeEntriesBySessionId.set(entry.sessionId, entry);
    }
  }
  const includeUnownedArtifacts = !isSharedFixedStore;
  const corpusEntries = [...activeEntriesBySessionId.values()];
  if (options.includeRetainedSqlite) {
    for (const instance of retainedInstances) {
      if (activeEntriesBySessionId.has(instance.sessionId)) {
        continue;
      }
      const { sessionKey, ownerAgentId } = resolveSessionOwnership(instance.sessionKey);
      // Retained rows need captured ownership before historical ingestion.
      if (
        ownerAgentId !== normalizedAgentId ||
        !instance.provenanceKnown ||
        instance.acpOwned ||
        instance.entry.pluginOwnerId ||
        instance.entry.hookExternalContentSource
      ) {
        continue;
      }
      corpusEntries.push(
        toSqliteEntry(
          ownerAgentId,
          instance.sessionId,
          sessionKey,
          instance.entry,
          "retained-session",
          instance.updatedAtMs,
        ),
      );
    }
  }
  for (const { path: artifactPath, contentRevision } of artifacts) {
    const artifactName = path.basename(artifactPath);
    const archivedIdentity = archivedIdentitiesByName.get(artifactName);
    const primarySessionId =
      archivedIdentity?.sessionId ?? parseUsageCountedSessionIdFromFileName(artifactName);
    if (!primarySessionId) {
      continue;
    }
    const primaryEntry = activeEntriesBySessionId.get(primarySessionId);
    const primaryOwner = entryOwnersBySessionId.get(primarySessionId);
    if (primaryOwner && primaryOwner !== normalizedAgentId) {
      continue;
    }
    if (!primaryOwner && !archivedIdentity && !includeUnownedArtifacts) {
      continue;
    }
    corpusEntries.push({
      ...toArtifactCorpusEntry(
        normalizedAgentId,
        artifactPath,
        primarySessionId,
        primaryEntry,
        contentRevision,
      ),
      ...(archivedIdentity?.sessionKey ? { sessionKey: archivedIdentity.sessionKey } : {}),
      ...(archivedIdentity ? { storePath } : {}),
    });
  }
  return corpusEntries;
}

function readCorpusSessionEntries(
  scope: SessionTranscriptCorpusScope,
  continuation?: CanonicalSessionReaderContinuation,
): SessionEntrySummary[] {
  const input = {
    agentId: scope.normalizedAgentId,
    env: scope.env,
    hydrateSkillPromptRefs: false,
    projection: "list",
    storePath: scope.storePath,
  } as const;
  return listSessionEntriesReadOnly(input, { continuation });
}

/** Project inventory in the admitted reader; only corpus metadata crosses the worker boundary. */
export function readSessionTranscriptCorpusInventory(
  scope: SessionTranscriptCorpusScope,
  options: SessionTranscriptCorpusOptions,
  artifacts: readonly SessionTranscriptCorpusArtifact[],
  databasePath: string,
  continuation?: CanonicalSessionReaderContinuation,
): SessionTranscriptCorpusEntry[] {
  return projectSessionTranscriptCorpusEntries(
    scope,
    options,
    artifacts,
    readCorpusSessionEntries({ ...scope, storePath: databasePath }, continuation),
    databasePath,
    continuation,
  );
}
