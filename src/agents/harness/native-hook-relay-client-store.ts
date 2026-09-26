import path from "node:path";
import { restoreNativeErrorResponse } from "../../infra/native-error-response.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { SqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import type {
  NativeHookRelayClientRead,
  NativeHookRelayClientReadResult,
} from "./native-hook-relay-client.worker.js";

/** Read one native relay locator without loading the shared-state writer lifecycle. */
export async function readNativeHookRelayClientBridgeRecord(params: {
  relayId: string;
  stateDbPath?: string;
}): Promise<NativeHookRelayBridgeRecord | undefined> {
  const pathname = path.resolve(params.stateDbPath ?? resolveOpenClawStateSqlitePath());
  const pool = new WorkerTaskPool<NativeHookRelayClientRead, NativeHookRelayClientReadResult>({
    workerUrl: resolveRuntimeProcessEntrypointUrl("nativeHookRelayClient"),
    maxWorkers: 1,
  });
  try {
    const result = await pool.run(
      { relayId: params.relayId, stateDbPath: pathname },
      { inputBytes: 2 * (params.relayId.length + pathname.length) },
    );
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
