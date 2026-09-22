import type { NativeHookRelayBridgeRecord } from "./native-hook-relay-bridge-record.js";
import type {
  NativeHookRelayBridgePruneCandidate,
  NativeHookRelayBridgePruneResult,
  NativeHookRelayBridgeSnapshot,
} from "./native-hook-relay-store.kernel.js";

export type NativeHookRelayStoreWorkerOperations = {
  "nativeHookRelay.read": {
    input: { relayId: string };
    output: NativeHookRelayBridgeRecord | undefined;
  };
  "nativeHookRelay.listSnapshots": { input: undefined; output: NativeHookRelayBridgeSnapshot[] };
  "nativeHookRelay.write": {
    input: { record: NativeHookRelayBridgeRecord; updatedAtMs: number };
    output: void;
  };
  "nativeHookRelay.renew": {
    input: { record: NativeHookRelayBridgeRecord; updatedAtMs: number };
    output: boolean;
  };
  "nativeHookRelay.deleteOwned": {
    input: { relayId: string; pid: number; token: string };
    output: boolean;
  };
  "nativeHookRelay.prune": {
    input: { candidates: NativeHookRelayBridgePruneCandidate[]; nowMs: number };
    output: NativeHookRelayBridgePruneResult[];
  };
};
