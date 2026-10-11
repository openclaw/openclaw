import type { Result } from "@openclaw/normalization-core/result";
import type { createAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import type {
  AgentDeletionJournalCleanupPath,
  AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";

export type AgentDeletionOperation = AgentDeletionWorkerAuthority & {
  entry: AgentDeletionJournalEntry;
  previousEntry?: AgentDeletionJournalEntry;
  runWithRemoteAdmission<T>(
    operation: (
      authority: Parameters<AgentDeletionJournalTransport>[1] & { databasePath: string },
      guard: AgentDeletionWorkerGuard,
    ) => Promise<Result<T, Error>>,
  ): Promise<T>;
  assertCurrentAsync(this: void): Promise<void>;
  assertCurrentFinal(this: void): void;
  runDatabaseCleanup: ReturnType<typeof createAgentDeletionDatabaseCleanup>;
  fenceDatabasePaths(paths: readonly string[]): Promise<void>;
  fenceCleanupPaths(paths: readonly AgentDeletionJournalCleanupPath[]): Promise<void>;
  retire(): Promise<void>;
  finish(options?: { unregisterDatabases?: boolean }): Promise<void>;
  releaseClawRows(input: {
    files: Array<{ path: string; action: string }>;
    complete: boolean;
  }): Promise<boolean>;
  handoffClawRetry(): Promise<void>;
  rollback(): Promise<void>;
};
