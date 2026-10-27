import {
  resetPluginStateStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import type {
  WarmImageRecord,
  WarmProfileRecord,
  WarmAllocationRecord,
} from "./crabbox-worker-warm-image-records.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import type { CommandCall } from "./crabbox-worker-warm-image.test-support.js";

export const firstWarmImage = async () => (await listCrabboxWarmImages(crabboxState))[0];
export const checkpointArgs = (calls: CommandCall[], action: string) =>
  calls.filter(({ argv }) => argv[2] === action).map(({ argv }) => argv);
export const commandArgs = (calls: CommandCall[], action: string) =>
  calls.filter(({ argv }) => argv[1] === action).map(({ argv }) => argv);

export async function closeWarmState(provider: { dispose(): Promise<void> }) {
  await provider.dispose();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

export function warmEntry() {
  const entry = openWarmImageStore().entries()[0];
  if (!entry) {
    throw new Error("Expected a captured warm image");
  }
  return entry;
}

export function updateWarmImage(patch: Partial<WarmImageRecord>) {
  const entry = warmEntry();
  const image = { ...entry.value.image!, ...patch };
  openWarmImageStore().register(entry.key, { ...entry.value, image });
  return entry;
}
const uncached = { preparationKey: null, cacheKey: null, purpose: null };

export function warmImage(id: string, patch: Partial<WarmImageRecord> = {}): WarmImageRecord {
  return {
    checkpointId: id,
    kind: "native",
    state: "available",
    createdAtMs: 1,
    ...uncached,
    lastDemandAtMs: 1,
    ...patch,
  };
}

export function warmRecord(patch: Partial<WarmProfileRecord> = {}): WarmProfileRecord {
  return { version: 3, allocations: {}, ...patch };
}

type Capture = Extract<NonNullable<WarmProfileRecord["operation"]>, { type: "capture" }>;
export function captureOperation(id: string, patch: Partial<Capture> = {}): Capture {
  return { type: "capture", id, phase: "creating", startedAtMs: Date.now(), ...patch };
}

export { createAsyncGate as pause } from "../../test-support/async-gate.test-support.js";

export const warmStore = <T = WarmProfileRecord>(env?: NodeJS.ProcessEnv) =>
  createPluginStateSyncKeyedStoreForTests<T>("crabbox", {
    namespace: "warm-images",
    maxEntries: 128,
    overflowPolicy: "reject-new",
    env,
  });

export const warmAllocation = (
  choice: WarmAllocationRecord["choice"] = { kind: "cold" },
  overrides: Partial<WarmAllocationRecord> = {},
): WarmAllocationRecord => ({
  machineClass: "standard",
  phase: "pending",
  choice,
  ...uncached,
  demandAtMs: null,
  imageGeneration: null,
  ...overrides,
});

export function expectText(text: string | undefined, contains: string[], excludes: string[] = []) {
  contains.forEach((value) => expect(text).toContain(value));
  excludes.forEach((value) => expect(text).not.toContain(value));
}
