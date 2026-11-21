// Accessor-backed transcript corpus discovery for memory session indexing.
import type { BigIntStats, Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import { isFileMissingError, normalizeComparablePath } from "./fs-utils.js";
import {
  extractAgentIdFromSessionsDir,
  cloneEnvWithPlatformSemantics,
  getRuntimeConfig,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  readSessionTranscriptCorpusInWorker,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "./openclaw-runtime-session.js";
import type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
  SessionTranscriptCorpusArtifact,
} from "./session-transcript-corpus.types.js";

export type {
  SessionTranscriptCorpusEntry,
  SessionTranscriptCorpusOptions,
} from "./session-transcript-corpus.types.js";

function fileContentRevisionFromStat(stat: BigIntStats): string | undefined {
  return stat.isFile()
    ? `file:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    : undefined;
}

async function normalizeRealComparablePathAsync(pathname: string): Promise<string> {
  try {
    return normalizeComparablePath(await fs.realpath(pathname));
  } catch {
    try {
      return normalizeComparablePath(
        path.join(await fs.realpath(path.dirname(pathname)), path.basename(pathname)),
      );
    } catch {
      return normalizeComparablePath(pathname);
    }
  }
}

function sessionTranscriptArtifactPaths(sessionsDir: string, entries: Dirent[]): string[] {
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isUsageCountedSessionTranscriptFileName(name))
    .filter((name) => isSessionArchiveArtifactName(name))
    .map((name) => path.join(sessionsDir, name));
}

function resolveSessionTranscriptCorpusScope(
  agentId: string,
  cfg: SessionTranscriptCorpusScope["cfg"],
): SessionTranscriptCorpusScope {
  const normalizedAgentId = normalizeAgentId(agentId);
  const env = cloneEnvWithPlatformSemantics(process.env);
  const configuredStore = cfg.session?.store;
  const storePath = resolveStorePath(configuredStore, {
    agentId: normalizedAgentId,
    env,
  });
  const sessionsDir = path.dirname(storePath);
  const fixedStoreOwnerAgentId = extractAgentIdFromSessionsDir(sessionsDir);
  const isAgentOwnedFixedStore =
    fixedStoreOwnerAgentId !== null &&
    normalizeAgentId(fixedStoreOwnerAgentId) === normalizedAgentId;
  const isSharedFixedStore =
    typeof configuredStore === "string" &&
    configuredStore.trim().length > 0 &&
    !configuredStore.includes("{agentId}") &&
    !isAgentOwnedFixedStore;
  return {
    cfg,
    env,
    normalizedAgentId,
    storePath,
    isSharedFixedStore,
    artifactDirs: [sessionsDir, resolveSessionTranscriptsDirForAgent(normalizedAgentId, env)],
  };
}

async function readSessionTranscriptCorpusArtifacts(
  scope: SessionTranscriptCorpusScope,
  options: SessionTranscriptCorpusOptions,
): Promise<SessionTranscriptCorpusArtifact[]> {
  const artifactDirs = new Map<string, string>();
  for (const dir of scope.artifactDirs) {
    artifactDirs.set(await normalizeRealComparablePathAsync(dir), dir);
  }
  const artifacts: SessionTranscriptCorpusArtifact[] = [];
  const seen = new Set<string>();
  // Keep filesystem preparation sequential; none of it may block Gateway callbacks.
  for (const dir of artifactDirs.values()) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isFileMissingError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const artifactPath of sessionTranscriptArtifactPaths(dir, entries)) {
      const comparablePath = await normalizeRealComparablePathAsync(artifactPath);
      if (seen.has(comparablePath)) {
        continue;
      }
      seen.add(comparablePath);
      let contentRevision: string | undefined;
      if (options.includeContentRevision !== false) {
        try {
          contentRevision = fileContentRevisionFromStat(
            await fs.stat(artifactPath, { bigint: true }),
          );
        } catch {
          contentRevision = undefined;
        }
      }
      artifacts.push({ path: artifactPath, contentRevision });
    }
  }
  return artifacts;
}

/**
 * Lists transcript corpus entries for memory indexing.
 *
 * Active sessions come from the session accessor seam; retained reset/delete
 * transcript artifacts remain explicit file artifacts until core owns archive
 * artifact enumeration.
 */
export async function listSessionTranscriptCorpusEntriesForAgent(
  agentId: string,
  options: SessionTranscriptCorpusOptions = {},
): Promise<SessionTranscriptCorpusEntry[]> {
  const { config, ...capturedOptions } = options;
  const scope = resolveSessionTranscriptCorpusScope(agentId, config ?? getRuntimeConfig());
  const prepareArtifacts = () => readSessionTranscriptCorpusArtifacts(scope, capturedOptions);
  return readSessionTranscriptCorpusInWorker(scope, capturedOptions, prepareArtifacts);
}
