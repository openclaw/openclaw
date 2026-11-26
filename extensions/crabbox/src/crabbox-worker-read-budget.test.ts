import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  createWarmProvider,
  LEASE_ID,
  PROFILE as WARM_PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };

it("cancels inspection on owner shutdown without releasing command custody early", async () => {
  const started = createDeferred<AbortSignal | undefined>();
  const childClosed = createDeferred<void>();
  const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
    if (argv[1] !== "inspect") {
      return undefined;
    }
    started.resolve(options.signal);
    await childClosed.promise;
    return commandResult({
      stdout: JSON.stringify({ id: LEASE_ID, state: "running", ready: true }),
    });
  });
  const owner = new AbortController();
  const reason = new Error("environment owner is shutting down");
  const lease = { leaseId: LEASE_ID, profile: PROFILE, signal: owner.signal };
  let settled = false;
  const inspection = provider.inspect(lease).then(
    (status) => {
      settled = true;
      return status;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    const childSignal = await started.promise;
    owner.abort(reason);
    expect(childSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    childClosed.resolve();
    expect(await inspection).toBe(reason);
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
  } finally {
    childClosed.resolve();
    await inspection;
    await provider.dispose();
  }
});

it("lets lifecycle inspection finish Crabbox's coordinator retry budget", async () => {
  const { provider, calls } = createWarmProvider();

  await expect(provider.inspect({ leaseId: LEASE_ID, profile: PROFILE })).resolves.toEqual({
    status: "active",
    sharedHost: false,
  });

  const inspect = calls.find(({ argv }) => argv[1] === "inspect");
  // Crabbox internal/cli/coordinator_read_retry.go: coordinatorReadBudget = time.Minute.
  expect(inspect?.options.timeoutMs).toBeGreaterThan(60_000);
});

const provisionTimeoutCases = [
  { name: "normal without setup", profile: { ...PROFILE }, minutes: 98 },
  {
    name: "normal with setup",
    profile: { ...PROFILE, setup: "install-node" },
    minutes: 113,
  },
  { name: "desktop without setup", profile: { ...PROFILE, desktop: true }, minutes: 163 },
  {
    name: "desktop with setup",
    profile: { ...PROFILE, desktop: true, setup: "install-node" },
    minutes: 178,
  },
] satisfies Array<{ name: string; profile: WorkerProfile; minutes: number }>;
it.each(provisionTimeoutCases)(
  "includes provision phases and cleanup for $name",
  ({ profile, minutes }) => {
    const { provider } = createWarmProvider();

    expect(provider.resolveProvisionTimeoutMs?.(profile)).toBe(
      minutes * 60_000 + CRABBOX_LIFECYCLE_TIMEOUT_MS + 15_000,
    );
  },
);
