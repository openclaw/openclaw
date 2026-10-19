import type {
  readOpenClawAgentDatabaseIdentity,
  openOpenClawAgentSqliteWorkerStoreV2,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryDatabaseFacts } from "./manager-retrieval-read.js";

/** Facts published by the worker that admitted the physical index. */
export type MemoryDatabaseAdmission = {
  engine?: "postgres";
  hasIndex: boolean;
  ftsAvailable: boolean;
  schemaVersion?: number;
  identity?: ReturnType<typeof readOpenClawAgentDatabaseIdentity>;
  facts?: MemoryDatabaseFacts;
};

export type MemoryDatabaseOpenOptions = {
  agentId: string;
  writeOptions: Parameters<typeof openOpenClawAgentSqliteWorkerStoreV2>[0] & { path: string };
  readOnly: boolean;
  allowExtension: boolean;
  maintenanceSource?: import("./manager-database-context.js").MemoryIndexDatabase;
  schema: import("./manager-publication-task.js").MemoryPublicationOperations["schema.admit"]["input"];
};
