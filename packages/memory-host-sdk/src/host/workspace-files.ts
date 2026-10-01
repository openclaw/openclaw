import type {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
} from "./internal.js";
import type { ResolvedMemorySearchConfig } from "./openclaw-runtime-agent.js";
import type { readMemoryFile } from "./read-file.js";

type MemoryFileMetadata = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
  mode: number;
};

type MemoryFileCommit = {
  filePath: string;
  tempPrefix: string;
  expectedHash?: string;
  allowInPlaceFallback?: boolean;
  conflictMessage?: string;
} & ({ content: string; expectedContent?: string } | { content: null; expectedContent: string });

/** File operations used by existing Gateway maintenance, without its state or locks. */
export type MemoryWorkspaceMaintenance = {
  readFile: (filePath: string) => Promise<Buffer>;
  stat: (filePath: string, followSymlinks: boolean) => Promise<MemoryFileMetadata>;
  listDirectory: (
    directory: string,
  ) => Promise<
    Array<Pick<MemoryFileMetadata, "isFile" | "isDirectory" | "isSymbolicLink"> & { name: string }>
  >;
  mkdir: (directory: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  resolveWritePath: (filePath: string) => Promise<string>;
  /** Preserve native publication errors; a lost reply must report publication: "uncertain". */
  commitContent: (params: MemoryFileCommit) => Promise<void>;
  resolveDreamsPath: () => Promise<string>;
  readDreams: (filePath: string) => Promise<string>;
  writeDreams: (filePath: string, content: string) => Promise<void>;
  replaceReport: (filePath: string, content: string) => Promise<void>;
  appendCorpus: (filePath: string, content: string) => Promise<number>;
};

export type MemoryWorkspaceWatchRequest = {
  agentId: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal"> & {
    sync: Pick<ResolvedMemorySearchConfig["sync"], "watchDebounceMs">;
  };
};

/** File operations only. The Gateway retains the index, embeddings and sessions. */
export type MemoryWorkspaceFiles = {
  maintenance?: MemoryWorkspaceMaintenance;
  listFiles: typeof listMemoryFiles;
  inspectFile: typeof buildFileEntry;
  readFile: typeof readMemoryFile;
  readForIndexing: (filePath: string) => Promise<{
    content: string;
    /** Canonical source from the read on the host, not a Gateway realpath lookup. */
    canonicalRelativePath?: string;
  }>;
  buildMultimodalChunk: (entry: Parameters<typeof buildMultimodalChunkForIndexing>[0]) => Promise<
    | (NonNullable<Awaited<ReturnType<typeof buildMultimodalChunkForIndexing>>> & {
        canonicalRelativePath?: string;
      })
    | null
  >;
  /** Subscription ends when aborted. A lost subscription must report unavailable. */
  watch: (
    request: MemoryWorkspaceWatchRequest,
    onChange: (event: "change" | "unavailable") => void,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Bound by the workspace registration owner, including retained managers. */
  assertCurrent: () => void;
};
