import type { OpenClawConfig } from "./openclaw-runtime-config.js";
import type { MemorySessionKind } from "./types.js";

type SessionTranscriptCorpusArtifactKind =
  | "active-session"
  | "retained-session"
  | "archive-artifact";

export type SessionTranscriptCorpusOptions = {
  /** Include rotated SQLite transcript identities retained behind current logical sessions. */
  includeRetainedSqlite?: boolean;
  /** Skip per-transcript revision reads when a caller only needs discovery metadata. */
  includeContentRevision?: boolean;
  /** Read session entries without joining the agent database writable lifecycle. */
  readOnly?: boolean;
};

export type SessionTranscriptCorpusEntry = {
  agentId: string;
  sessionFile: string;
  sessionId: string;
  /** Canonical source revision used by derived transcript consumers. */
  contentRevision?: string;
  artifactKind: SessionTranscriptCorpusArtifactKind;
  sessionKey?: string;
  storePath?: string;
  /** Present when an active transcript is addressed by SQLite identity, not a JSONL path. */
  transcriptSource?: "sqlite";
  /** Session entry activity timestamp used when the source has no filesystem stat. */
  updatedAtMs?: number;
  /** True when this transcript belongs to an internal dreaming narrative run. */
  generatedByDreamingNarrative?: boolean;
  /** True when this transcript belongs to an isolated cron run session. */
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
};

export type SessionTranscriptCorpusScope = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  normalizedAgentId: string;
  storePath: string;
  isSharedFixedStore: boolean;
  artifactDirs: string[];
};

export type SessionTranscriptCorpusArtifact = { path: string; contentRevision?: string };
