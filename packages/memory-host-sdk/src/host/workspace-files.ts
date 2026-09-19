import type {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  listMemoryFiles,
} from "./internal.js";
import type { ResolvedMemorySearchConfig } from "./openclaw-runtime-agent.js";
import type { readMemoryFile } from "./read-file.js";

export type MemoryWorkspaceWatchRequest = {
  agentId: string;
  settings: Pick<ResolvedMemorySearchConfig, "extraPaths" | "multimodal"> & {
    sync: Pick<ResolvedMemorySearchConfig["sync"], "watchDebounceMs">;
  };
};

/** File operations only. The Gateway retains the index, embeddings and sessions. */
export type MemoryWorkspaceFiles = {
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
