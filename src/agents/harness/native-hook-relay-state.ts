import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { NativeHookRelaySharedState } from "./native-hook-relay-types.js";

export const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;

export const nativeHookRelayState = resolveGlobalSingleton<NativeHookRelaySharedState>(
  Symbol.for("openclaw.nativeHookRelay.state"),
  () => ({
    relays: new Map(),
    relayBridges: new Map(),
    pendingOperations: new Set(),
    invocations: [],
    pendingPermissionApprovals: new Map(),
    pendingPreToolUseApprovals: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  }),
);
