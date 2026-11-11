import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  checkpointArgs,
  commandArgs,
  firstWarmImage,
  warmEntry,
  captureOperation,
} from "./crabbox-warm-scenarios.test-support.js";
import { destroyAndWait } from "./crabbox-worker-provider.test-support.js";
import {
  captureWarmImage,
  createWarmProvider,
  provisionWarmProfile,
  OPERATION_ID,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

export function scenario(...args: Parameters<typeof createWarmProvider>) {
  const fixture = createWarmProvider(...args);
  const { provider, calls } = fixture;
  return {
    ...fixture,
    store: openWarmImageStore(),
    entry: warmEntry,
    summary: firstWarmImage,
    checkpoints: (action: string) => checkpointArgs(calls, action),
    commands: (action: string) => commandArgs(calls, action),
    provision: (
      id = OPERATION_ID,
      profile: WorkerProfile = PROFILE,
      options?: Parameters<typeof provisionWarmProfile>[4],
    ) => provisionWarmProfile(provider, profile, id, undefined, options),
    capture: (id = OPERATION_ID, profile: WorkerProfile = PROFILE) =>
      captureWarmImage(provider, profile, id),
    stop: (lease: { leaseId: string }, profile: WorkerProfile = PROFILE) =>
      destroyAndWait(provider, { leaseId: lease.leaseId, profile }),
  };
}

export async function capacityScenario(
  command?: Parameters<typeof createWarmProvider>[0],
  protectCapture = false,
) {
  const s = scenario(command);
  await s.capture();
  const image = s.entry();
  const now = Date.now();
  const retained = {
    ...image.value,
    image: { ...image.value.image!, lastDemandAtMs: now - 86_400_000 },
    operation: captureOperation("capacity-capture", { leaseId: "cbx_capturing", provider: "aws" }),
  };
  if (protectCapture) {
    s.store.register(image.key, retained);
  }
  for (let index = 0; index < 127; index++) {
    s.store.register(`idle-${index}`, {
      ...image.value,
      image: {
        ...image.value.image!,
        checkpointId: `chk_idle_${index}`,
        lastDemandAtMs: now + (protectCapture ? 0 : 1),
      },
    });
  }
  return { s, image, retained };
}
