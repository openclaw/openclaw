import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { testing } from "./native-hook-relay.js";

export function clearNativeHookRelayBridgeRecordsForTests(): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("DELETE FROM native_hook_relay_bridges").run();
  });
}

export async function clearNativeHookRelaysForTests(): Promise<void> {
  await testing.clearNativeHookRelaysForTests();
  clearNativeHookRelayBridgeRecordsForTests();
}
