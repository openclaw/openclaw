import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import type {
  NativeHookRelayBridgePruneCandidate,
  NativeHookRelayBridgePruneResult,
} from "./native-hook-relay-store.kernel.js";

export type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";

type NativeHookRelayBridgeStoreOptions = { stateDbPath?: string };
type NativeHookRelayBridgeWriteParams = NativeHookRelayBridgeStoreOptions & {
  record: NativeHookRelayBridgeRecord;
  updatedAtMs?: number;
  assertCurrent?: () => void;
};

export async function readNativeHookRelayBridgeRecord(
  params: { relayId: string } & NativeHookRelayBridgeStoreOptions,
): Promise<NativeHookRelayBridgeRecord | undefined> {
  const context = captureOpenClawStateWorkerContext({ path: params.stateDbPath });
  const input = { relayId: params.relayId };
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "nativeHookRelay.read", input }),
    { existingOnly: true },
  );
}

function persistNativeHookRelayBridgeRecord<
  Type extends "nativeHookRelay.write" | "nativeHookRelay.renew",
>(type: Type, params: NativeHookRelayBridgeWriteParams) {
  const context = captureOpenClawStateWorkerContext({ path: params.stateDbPath });
  const input = { record: { ...params.record }, updatedAtMs: params.updatedAtMs ?? Date.now() };
  const assertCurrent = params.assertCurrent;
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute({ type, input }), {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage !== "transaction") {
          throw new Error("Native hook relay persistence requires transaction admission");
        }
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}

export async function writeNativeHookRelayBridgeRecord(
  params: NativeHookRelayBridgeWriteParams,
): Promise<void> {
  await persistNativeHookRelayBridgeRecord("nativeHookRelay.write", params);
}

export async function renewOrRestoreNativeHookRelayBridgeRecord(
  params: NativeHookRelayBridgeWriteParams,
): Promise<boolean> {
  return persistNativeHookRelayBridgeRecord("nativeHookRelay.renew", params);
}

export async function deleteNativeHookRelayBridgeRecordIfOwned(params: {
  relayId: string;
  pid: number;
  token: string;
  stateDbPath?: string;
}): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext({ path: params.stateDbPath });
  const input = { relayId: params.relayId, pid: params.pid, token: params.token };
  return runOpenClawStateWorkerOperation(context, (scope) =>
    scope.execute({ type: "nativeHookRelay.deleteOwned", input }),
  );
}

export async function pruneNativeHookRelayBridgeRecords(params: {
  currentPid: number;
  isPidDead: (pid: number) => boolean | Promise<boolean>;
  nowMs?: number;
  stateDbPath?: string;
}): Promise<NativeHookRelayBridgePruneResult[]> {
  const context = captureOpenClawStateWorkerContext({ path: params.stateDbPath });
  const nowMs = params.nowMs ?? Date.now();
  const { currentPid, isPidDead } = params;
  return runOpenClawStateWorkerOperation(context, async (scope) => {
    const snapshots = await scope.execute({
      type: "nativeHookRelay.listSnapshots",
      input: undefined,
    });
    const candidates: NativeHookRelayBridgePruneCandidate[] = [];
    for (const snapshot of snapshots) {
      if (nowMs > snapshot.record.expiresAtMs) {
        candidates.push({ snapshot, reason: "expired" });
        continue;
      }
      if (snapshot.record.pid !== currentPid && (await isPidDead(snapshot.record.pid))) {
        candidates.push({ snapshot, reason: "dead-pid" });
      }
    }
    return candidates.length === 0
      ? []
      : scope.execute({ type: "nativeHookRelay.prune", input: { candidates, nowMs } });
  });
}

export async function clearNativeHookRelayBridgeRecordsForTests(
  options: NativeHookRelayBridgeStoreOptions = {},
): Promise<void> {
  const [{ runOpenClawStateWriteTransaction }, { clearNativeHookRelayBridgeRecordsInDatabase }] =
    await Promise.all([
      import("../../state/openclaw-state-db.js"),
      import("./native-hook-relay-store.kernel.js"),
    ]);
  runOpenClawStateWriteTransaction(clearNativeHookRelayBridgeRecordsInDatabase, {
    path: options.stateDbPath,
  });
}
