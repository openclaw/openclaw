import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resetPluginStateStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect } from "vitest";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  listCrabboxWarmImages,
  type WarmImageRecord,
  type WarmProfileRecord,
  type WarmAllocationRecord,
} from "./crabbox-worker-warm-image-store.js";
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
  openWarmImageStore().register(entry.key, {
    ...entry.value,
    image: { ...entry.value.image!, ...patch },
  });
  return entry;
}

export const warmImage = (
  checkpointId: string,
  overrides: Partial<WarmImageRecord> = {},
): WarmImageRecord => ({
  checkpointId,
  kind: "native",
  state: "available",
  createdAtMs: 1,
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  lastDemandAtMs: 1,
  ...overrides,
});

export const warmRecord = (overrides: Partial<WarmProfileRecord> = {}): WarmProfileRecord => ({
  version: 3,
  allocations: {},
  ...overrides,
});

type CaptureOperation = Extract<NonNullable<WarmProfileRecord["operation"]>, { type: "capture" }>;
export const captureOperation = (
  id: string,
  overrides: Partial<CaptureOperation> = {},
): CaptureOperation => ({
  type: "capture",
  id,
  phase: "creating",
  startedAtMs: Date.now(),
  ...overrides,
});

export function pause() {
  const entered = createDeferred<void>(),
    released = createDeferred<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    async wait(this: void) {
      entered.resolve();
      await released.promise;
    },
  };
}

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
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  demandAtMs: null,
  imageGeneration: null,
  ...overrides,
});

export function expectText(text: string | undefined, contains: string[], excludes: string[] = []) {
  for (const value of contains) {
    expect(text).toContain(value);
  }
  for (const value of excludes) {
    expect(text).not.toContain(value);
  }
}
