import type { WorkerProfile } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { CRABBOX_LIFECYCLE_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";
import {
  createWarmProvider,
  LEASE_ID,
  PROFILE as WARM_PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };

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
