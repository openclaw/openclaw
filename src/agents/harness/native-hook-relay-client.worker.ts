import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import type { NativeErrorResponse } from "../../infra/native-error-response-schema.js";
import { serializeNativeErrorResponse } from "../../infra/native-error-response.js";
import { SqliteSchemaVersionError } from "../../infra/sqlite-user-version.js";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import {
  readNativeHookRelayClientRecord,
  type NativeHookRelayClientRead,
} from "./native-hook-relay-client-read.js";

export type NativeHookRelayClientReadResult =
  | { ok: true; record: NativeHookRelayBridgeRecord | undefined }
  | { ok: false; error: NativeErrorResponse; newerSchema: boolean };

serveWorkerTasks<NativeHookRelayClientReadResult, NativeHookRelayClientRead>((input) => {
  try {
    return {
      ok: true,
      record: readNativeHookRelayClientRecord(input, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
    };
  } catch (value) {
    const error = toStringifiedError(value);
    return {
      ok: false,
      error: serializeNativeErrorResponse(error),
      newerSchema: error instanceof SqliteSchemaVersionError,
    };
  }
});
