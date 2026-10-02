import path from "node:path";
import { restoreNativeErrorResponse } from "../../infra/native-error-response.js";
import { SqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import type { NativeHookRelayClientRead } from "./native-hook-relay-client-read.js";
import type { NativeHookRelayClientReadResult } from "./native-hook-relay-client.worker.js";

/** Read one native relay locator without loading the shared-state writer lifecycle. */
export async function readNativeHookRelayClientBridgeRecord(params: {
  relayId: string;
  stateDbPath?: string;
}): Promise<NativeHookRelayBridgeRecord | undefined> {
  const pathname = path.resolve(params.stateDbPath ?? resolveOpenClawStateSqlitePath());
  const input = { relayId: params.relayId, stateDbPath: pathname };
  if (!process.versions.bun) {
    // The one-shot Node CLI already owns its process. Never block its deadline
    // on a SQLite lock; the asynchronous bridge retry owner handles contention.
    const { readNativeHookRelayClientRecord } = await import("./native-hook-relay-client-read.js");
    return readNativeHookRelayClientRecord(input, 0);
  }
  // Bun retains native SQLite handles after close until the worker exits.
  const [{ WorkerTaskPool }, { resolveRuntimeProcessEntrypointUrl }] = await Promise.all([
    import("../../infra/worker-task-pool.js"),
    import("../../infra/runtime-process-url.js"),
  ]);
  const pool = new WorkerTaskPool<NativeHookRelayClientRead, NativeHookRelayClientReadResult>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("nativeHookRelayClient"),
    maxWorkers: 1,
  });
  try {
    const result = await pool.run(input, {
      inputBytes: 2 * (params.relayId.length + pathname.length),
    });
    if (!result.ok) {
      throw result.newerSchema
        ? new SqliteSchemaVersionError(result.error.message)
        : restoreNativeErrorResponse(result.error);
    }
    return result.record;
  } finally {
    await pool.close();
  }
}
