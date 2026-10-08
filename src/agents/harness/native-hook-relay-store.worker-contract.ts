import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { nativeHookRelayOperations } from "./native-hook-relay-store.worker.js";

export type NativeHookRelayStoreWorkerOperations = WorkerOperations<
  typeof nativeHookRelayOperations
>;
