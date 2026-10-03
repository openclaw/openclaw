import type {
  OpenAsyncKeyedStoreOptions,
  PluginStateCompareIntent,
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  parseCrabboxProfile,
  resolveCrabboxWarmImageProfileKey,
} from "./crabbox-worker-profile.js";
import { observeWarmComparisonAdmission } from "./crabbox-worker-warm-image-admission.test-support.js";
import type {
  WarmAllocationRecord,
  WarmImageRecord,
  WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import {
  createWarmProvider,
  NODE_RUNTIME_IDENTITY,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

export const parsedProfile = parseCrabboxProfile(PROFILE);
export const profileKey = resolveCrabboxWarmImageProfileKey(parsedProfile);

export function currentAuthority(label = "invocation") {
  const controller = new AbortController();
  const closed = new Error("synthetic " + label + " authority closed");
  let active = true;
  return {
    signal: controller.signal,
    closed,
    close: () => {
      active = false;
    },
    assertCurrent: vi.fn(() => {
      controller.signal.throwIfAborted();
      if (!active) {
        throw closed;
      }
    }),
  };
}

export function warmAllocation(
  overrides: Partial<WarmAllocationRecord> = {},
): WarmAllocationRecord {
  return {
    choice: { kind: "cold" },
    machineClass: "standard",
    os: "linux",
    phase: "pending",
    preparationKey: null,
    cacheKey: null,
    purpose: null,
    demandAtMs: Date.now(),
    imageGeneration: null,
    runtimeIdentity: NODE_RUNTIME_IDENTITY,
    ...overrides,
  };
}

export function warmImage(overrides: Partial<WarmImageRecord> = {}): WarmImageRecord {
  return {
    checkpointId: "chk_sibling_source",
    kind: "aws-ebs-snapshot",
    state: "available",
    createdAtMs: Date.now(),
    preparationKey: null,
    cacheKey: null,
    purpose: null,
    lastDemandAtMs: Date.now(),
    runtimeIdentity: NODE_RUNTIME_IDENTITY,
    ...overrides,
  };
}

export type WarmComparisonDelivery = {
  namespace: string;
  key: string;
  intent: PluginStateCompareIntent<unknown>;
  result: PluginStateCompareResult<unknown>;
};

export function createSiblingFixture(
  command?: Parameters<typeof createWarmProvider>[0],
  deliver?: (comparison: WarmComparisonDelivery) => Promise<void>,
  managerPolicy?: Parameters<typeof createCrabboxWarmImageManager>[0]["policy"],
) {
  const lifetime = currentAuthority("plugin lifetime");
  // The real factory's THIRD argument models production runtime lifecycle binding.
  vi.spyOn(crabboxState, "openKeyedStore").mockImplementation(
    <T>(options: OpenAsyncKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>(
        "crabbox",
        options,
        lifetime.assertCurrent,
      );
      if (!deliver) {
        return store;
      }
      const observeDelivery = <View extends PluginStateKeyedStore<T, 2>>(view: View) => ({
        ...view,
        async compareAndApply(
          key: string,
          comparison: string,
          intent: PluginStateCompareIntent<T>,
        ) {
          // Await THIS view's real worker result before perturbing caller delivery.
          // A failure here never retries or substitutes the already-settled mutation.
          const result = await view.compareAndApply(key, comparison, intent);
          await deliver({ namespace: options.namespace, key, intent, result });
          return result;
        },
      });
      return {
        ...observeDelivery(store),
        withCurrent: (authority: Parameters<typeof store.withCurrent>[0]) =>
          observeDelivery(store.withCurrent(authority)),
      };
    },
  );
  const provider = createWarmProvider(command);
  const store = createPluginStateKeyedStoreForTests<WarmProfileRecord>(
    "crabbox",
    { namespace: "warm-images", maxEntries: 128, overflowPolicy: "reject-new" },
    lifetime.assertCurrent,
  );
  const runCommand = vi.fn<CrabboxCommandRunner>(async () => {
    throw new Error("This direct manager scenario must not dispatch a provider command");
  });
  const managerWarn = vi.fn<(message: string) => void>();
  const manager = createCrabboxWarmImageManager({
    state: crabboxState,
    runCommand,
    warn: managerWarn,
    policy: managerPolicy,
  });
  return {
    ...provider,
    store,
    lifetime,
    manager,
    managerWarn,
    runCommand,
    async reopen(key = profileKey) {
      await closeOpenClawStateDatabaseAsync();
      return store.lookup(key);
    },
  };
}

export function atWarmComparisonCommit(
  matches: (record: WarmProfileRecord) => boolean,
  close: () => void,
  timing: "before grant" | "after grant" = "before grant",
  key = profileKey,
) {
  let matchingCount = 0;
  let closures = 0;
  const observation = observeWarmComparisonAdmission({
    key,
    matches,
    beforeAdmit: (stage) => {
      if (stage === "commit" && timing === "before grant") {
        closures += 1;
        close();
      }
    },
    afterAdmit: (stage) => {
      if (stage === "commit" && timing === "after grant") {
        closures += 1;
        close();
      }
    },
  });
  return {
    async run<T>(operation: () => Promise<T>) {
      try {
        return await operation().then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      } finally {
        matchingCount = observation.submissions().length;
        observation.restore();
      }
    },
    expectDecision(error?: Error) {
      expect(matchingCount).toBe(1);
      expect(closures).toBe(1);
      // A transient unauthorized claim can later be cleared. Its actual native
      // admission decision, not final row equality alone, must therefore refuse.
      expect
        .soft(observation.decisions)
        .toEqual([
          { stage: "transaction", granted: true },
          error ? { stage: "commit", granted: false, error } : { stage: "commit", granted: true },
        ]);
    },
  };
}
