import type { EngineConnection } from "openclaw/plugin-sdk/database-engine-worker-runtime";
import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import { loadMemoryEmbeddingCache } from "./manager-embedding-cache.js";
import type { MemoryPublicationOperations } from "./manager-publication-task.js";
import { readMemoryDatabaseFacts } from "./manager-retrieval-read.js";
import { readMemorySourceChunks, readMemorySourceHash } from "./manager-source-index-kernel.js";
import { loadMemorySourceFileState } from "./manager-source-state.js";

export type MemoryIndexReadOperations = Pick<
  MemoryPublicationOperations,
  "index.facts" | "source.state" | "source.hash" | "source.chunks" | "cache.read"
>;
export type MemoryIndexReadCommand = SqliteWorkerCommand<MemoryIndexReadOperations>;

/** Published WAL readers and private shadow writers consume the same read kernels. */
export function readMemoryIndex(db: EngineConnection, command: MemoryIndexReadCommand) {
  switch (command.type) {
    case "index.facts":
      return { type: command.type, value: readMemoryDatabaseFacts(db) };
    case "source.state":
      return { type: command.type, value: loadMemorySourceFileState({ db, ...command.input }) };
    case "source.hash":
      return {
        type: command.type,
        value: readMemorySourceHash(db, command.input.source, command.input.path),
      };
    case "source.chunks":
      return {
        type: command.type,
        value: readMemorySourceChunks(db, command.input.source, command.input.path),
      };
    case "cache.read":
      return { type: command.type, value: loadMemoryEmbeddingCache({ ...command.input, db }) };
  }
  const unreachable: never = command;
  return unreachable;
}
