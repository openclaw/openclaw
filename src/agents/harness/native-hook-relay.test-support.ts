import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  registerOwnedNativeHookRelay,
  testing,
} from "./native-hook-relay.js";

export function registerRelay(
  overrides: Partial<Parameters<typeof registerNativeHookRelay>[0]> = {},
) {
  return registerNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  });
}

export function registerOwnedRelay(
  overrides: Partial<Parameters<typeof registerOwnedNativeHookRelay>[0]> = {},
) {
  return registerOwnedNativeHookRelay({
    provider: "codex",
    sessionId: "session-1",
    runId: "run-1",
    ...overrides,
  });
}

export function invokeRelay(
  relayId: string,
  event: Parameters<typeof invokeNativeHookRelay>[0]["event"],
  rawPayload: unknown,
  options: Omit<
    Parameters<typeof invokeNativeHookRelay>[0],
    "provider" | "relayId" | "event" | "rawPayload"
  > = {},
) {
  return invokeNativeHookRelay({ provider: "codex", relayId, event, rawPayload, ...options });
}

export function registerAgentRelay(
  overrides: Partial<Parameters<typeof registerNativeHookRelay>[0]> = {},
) {
  return registerRelay({
    agentId: "agent-1",
    sessionKey: "agent:main:session-1",
    ...overrides,
  });
}

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
