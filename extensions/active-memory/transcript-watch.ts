import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";
import { rethrowIncognitoSessionError } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readMemoryResultFromSessionRecord,
  streamActiveMemoryTranscriptRecords,
} from "./transcript.js";
import {
  TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS,
  type ActiveMemorySearchDebug,
  type ActiveMemoryTranscriptSource,
  type TerminalMemorySearchResult,
  type TerminalMemorySearchWatch,
} from "./types.js";

export async function readMergedActiveMemoryTranscriptState(params: {
  sources: readonly ActiveMemoryTranscriptSource[];
  toolsAllow: readonly string[];
}): Promise<{
  searchDebug?: ActiveMemorySearchDebug;
  hasUsableMemoryResult: boolean;
  hasUnavailableMemorySearchResult: boolean;
}> {
  let searchDebug: ActiveMemorySearchDebug | undefined;
  let hasUsableMemoryResult = false;
  let hasUnavailableMemorySearchResult = false;
  for (const source of params.sources) {
    await streamActiveMemoryTranscriptRecords({
      source,
      onRecord: (record) => {
        const result = readMemoryResultFromSessionRecord(record, params.toolsAllow);
        searchDebug = result.searchDebug ?? searchDebug;
        hasUnavailableMemorySearchResult ||= result.hasUnavailableMemorySearchResult;
        hasUsableMemoryResult ||= result.hasUsableMemoryResult;
      },
    });
  }
  return { searchDebug, hasUsableMemoryResult, hasUnavailableMemorySearchResult };
}

async function readTerminalMemorySearchResult(
  source: ActiveMemoryTranscriptSource,
  toolsAllow: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  // memory_get consumes a path discovered by another tool; it is not an
  // independent fallback that should delay terminal unavailability.
  const recallPathNames = new Set(
    toolsAllow
      .map((toolName) => normalizeLowercaseStringOrEmpty(toolName))
      .filter((toolName) => toolName && toolName !== "memory_get"),
  );
  if (recallPathNames.size === 0) {
    return undefined;
  }
  const unavailablePathNames = new Set<string>();
  let hasUsableMemoryResult = false;
  let searchDebug: ActiveMemorySearchDebug | undefined;
  await streamActiveMemoryTranscriptRecords({
    source,
    onRecord: (record) => {
      const result = readMemoryResultFromSessionRecord(record, toolsAllow);
      hasUsableMemoryResult ||= result.hasUsableMemoryResult;
      searchDebug = result.searchDebug ?? searchDebug;
      const toolName = result.toolName;
      if (!toolName || !recallPathNames.has(toolName)) {
        return false;
      }
      if (result.terminalUnavailable) {
        unavailablePathNames.add(toolName);
      } else {
        unavailablePathNames.delete(toolName);
      }
      return false;
    },
  });
  if (unavailablePathNames.size !== recallPathNames.size) {
    return undefined;
  }
  return {
    status: "unavailable",
    hasUsableMemoryResult,
    searchDebug,
  };
}

async function readTerminalMemorySearchResultFromSources(
  sources: readonly ActiveMemoryTranscriptSource[],
  toolsAllow: readonly string[],
): Promise<TerminalMemorySearchResult | undefined> {
  for (const source of sources) {
    const result = await readTerminalMemorySearchResult(source, toolsAllow);
    if (result) {
      return result;
    }
  }
  return undefined;
}

export function watchTerminalMemorySearchResult(params: {
  getTranscriptSources: () => readonly ActiveMemoryTranscriptSource[];
  abortSignal: AbortSignal;
  toolsAllow: readonly string[];
}): TerminalMemorySearchWatch {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, params.abortSignal]);
  const {
    promise,
    resolve: resolveWatch,
    reject: rejectWatch,
  } = createDeferred<TerminalMemorySearchResult>();
  const stop = () => controller.abort();
  const poll = async () => {
    while (!signal.aborted) {
      try {
        const result = await readTerminalMemorySearchResultFromSources(
          params.getTranscriptSources(),
          params.toolsAllow,
        );
        // Execution can settle while this transcript read is still in flight.
        if (signal.aborted) {
          return;
        }
        if (result) {
          stop();
          resolveWatch(result);
          return;
        }
      } catch (error) {
        rethrowIncognitoSessionError(error);
        // Transcript polling is opportunistic; normal timeout handling remains authoritative.
      }
      await sleepWithAbort(TERMINAL_MEMORY_SEARCH_POLL_INTERVAL_MS, signal, { ref: false }).catch(
        () => undefined,
      );
    }
  };
  void poll().catch(rejectWatch);
  return {
    promise,
    stop,
  };
}
