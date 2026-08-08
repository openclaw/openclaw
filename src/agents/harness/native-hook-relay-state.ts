import type { NativeHookRelaySharedState } from "./native-hook-relay-types.js";

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");
export const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  const state = (globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map(),
    relayBridges: new Map(),
    retiredRelayBridges: new Set(),
    invocations: [],
    pendingPermissionApprovals: new Map(),
    pendingPreToolUseApprovals: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  });
  state.retiredRelayBridges ??= new Set();
  return state;
}

export const nativeHookRelayState = getNativeHookRelaySharedState();
