import { codexNativeHookRelayOwners } from "./native-hook-relay-state.js";

export function clearCodexNativeHookRelayOwners(): void {
  for (const owner of codexNativeHookRelayOwners.values()) {
    owner.dispose();
  }
  codexNativeHookRelayOwners.clear();
}

export function codexNativeHookRelayOwnerCount(): number {
  return codexNativeHookRelayOwners.size;
}
