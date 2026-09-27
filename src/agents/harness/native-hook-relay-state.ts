import type { NativeHookRelaySharedState } from "./native-hook-relay-types.js";

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");
export const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map(),
    relayBridges: new Map(),
    pendingOperations: new Set(),
    invocations: [],
    pendingPermissionApprovals: new Map(),
    pendingPreToolUseApprovals: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

export const nativeHookRelayState = getNativeHookRelaySharedState();

// Duplicate module copies share the symbol-backed object. Upgrade older state
// in place so a hot plugin refresh does not split relay ownership.
export const nativeHookRelayRegistrationsById = (nativeHookRelayState.relayRegistrationsById ??=
  new Map());
export const nativeHookRelayRetiredTurnClaimsById = (nativeHookRelayState.retiredTurnClaimsById ??=
  new Map());
