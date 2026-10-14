import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { testing, type invokeNativeHookRelay } from "./native-hook-relay.js";

export function createNativeHookRelayPermissionRequestFixture(
  relayId: string,
  toolUseId: string,
  toolInput: Record<string, unknown> = { command: "git status" },
): Parameters<typeof invokeNativeHookRelay>[0] {
  return {
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: "/repo",
      tool_name: "Bash",
      tool_use_id: toolUseId,
      tool_input: toolInput,
    },
  };
}

export function clearNativeHookRelayBridgeRecordsForTests(): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("DELETE FROM native_hook_relay_bridges").run();
  });
}

export async function clearNativeHookRelaysForTests(): Promise<void> {
  await testing.clearNativeHookRelaysForTests();
  clearNativeHookRelayBridgeRecordsForTests();
}
