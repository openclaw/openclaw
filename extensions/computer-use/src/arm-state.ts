import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type ComputerArmState = {
  armedAtMs: number;
  expiresAtMs: number | null;
  armedBy?: string;
};

export type ComputerArmStore = Pick<
  PluginStateKeyedStore<ComputerArmState>,
  "delete" | "entries" | "lookup" | "register"
>;

export function isArmed(state: ComputerArmState | null | undefined, nowMs: number): boolean {
  return (
    state !== null &&
    state !== undefined &&
    (state.expiresAtMs === null || state.expiresAtMs > nowMs)
  );
}

export async function readComputerArmState(
  store: ComputerArmStore,
  nodeId: string,
): Promise<ComputerArmState | null> {
  return (await store.lookup(nodeId)) ?? null;
}

export async function writeComputerArmState(
  store: ComputerArmStore,
  nodeId: string,
  state: ComputerArmState,
): Promise<void> {
  await store.register(nodeId, state);
}

export async function deleteComputerArmState(
  store: ComputerArmStore,
  nodeId: string,
): Promise<boolean> {
  return await store.delete(nodeId);
}
