import { isStringArray } from "openclaw/plugin-sdk/collection-input-runtime";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
  runUtf8CommandWithTimeout,
} from "openclaw/plugin-sdk/process-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  hasAgentScopeColumn,
  legacyMemorySchemaError,
  memoryAgentPredicate,
  MEMORY_TABLE_NAME,
} from "./lancedb-schema.js";
import { memoryStatsRuntimeEntrypoint } from "./memory-stats-entrypoint.js";

export type MemoryStatsSource = {
  dbPath: string;
  storageOptions?: Record<string, string>;
};

export async function readMemoryStats(source: MemoryStatsSource, agentId: string): Promise<number> {
  const moduleUrl = resolveRuntimeWorkerUrl(memoryStatsRuntimeEntrypoint);
  const result = await runUtf8CommandWithTimeout(
    [process.execPath, ...resolveRuntimeWorkerArgv(moduleUrl)],
    {
      input: JSON.stringify({
        ...source,
        // Source children do not inherit the host plugin loader's SDK aliases.
        fileLockUrl: moduleUrl.pathname.endsWith(".ts")
          ? import.meta.resolve("openclaw/plugin-sdk/file-lock")
          : undefined,
        tableName: MEMORY_TABLE_NAME,
        predicate: memoryAgentPredicate(agentId),
      }),
      timeoutMs: 60_000,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (result.cleanup === "uncertain") {
    throw new Error(
      "memory-lancedb: statistics reader stopped responding; process cleanup could not be confirmed. Check the local process before retrying.",
    );
  }
  if (result.termination === "timeout") {
    throw new Error(
      "memory-lancedb: statistics timed out after 60 seconds; the reader was stopped. Check database availability, then retry.",
    );
  }
  if (result.code !== 0 || result.termination !== "exit") {
    throw new Error(
      `memory-lancedb: statistics reader failed (${result.termination}, exit ${result.code}). ${result.stderr.trim()}`,
    );
  }
  const reply = asOptionalRecord(JSON.parse(result.stdout));
  const columns = reply?.columns;
  if (
    isStringArray(columns) &&
    !hasAgentScopeColumn({ fields: columns.map((name) => ({ name })) })
  ) {
    throw legacyMemorySchemaError();
  }
  if (typeof reply?.error === "string") {
    throw new Error(`memory-lancedb: statistics failed: ${reply.error}`);
  }
  if (typeof reply?.count !== "number" || !Number.isSafeInteger(reply.count) || reply.count < 0) {
    throw new Error("memory-lancedb: statistics reader returned an invalid count.");
  }
  return reply.count;
}
