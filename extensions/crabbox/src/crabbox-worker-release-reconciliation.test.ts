import { afterEach, expect, it, vi } from "vitest";
import * as support from "../../../src/gateway/worker-environments/service.test-support.js";
import {
  createProviderTestHarness,
  commandResult,
} from "./crabbox-worker-provider.test-support.js";

// mock-isolation: Exercise the real provider and Gateway sweep with fixed CLI responses.
vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));

support.setupWorkerEnvironmentServiceSuite();
const { createProvider } = createProviderTestHarness({}, "openclaw-crabbox-release-");
afterEach(() => vi.restoreAllMocks());

it("settles a failed stop on the next sweep when Crabbox confirms release", async () => {
  const environmentId = "released-worker";
  const leaseId = "cbx_012345abcdef";
  const failure = `coordinator accepted release for ${leaseId}, but remote cleanup reported a cleanup failure or scheduled retry`;
  let cleanupPending = true;
  const stop = vi.fn(() => commandResult({ code: 5, stderr: failure }));
  const inspect = vi.fn(() =>
    commandResult({
      stdout: JSON.stringify({
        id: leaseId,
        state: "released",
        serverId: "0",
        ready: false,
        ...(cleanupPending ? { cleanupRetryAt: "2026-10-30T00:01:00Z" } : {}),
      }),
    }),
  );
  const provider = createProvider({
    runCommand: async (argv) => {
      if (argv[1] === "stop") {
        return stop();
      }
      if (argv[1] === "inspect") {
        return inspect();
      }
      throw new Error(`Unexpected Crabbox command: ${argv[1]}`);
    },
  });
  const { store } = support.testState;
  await store.createIntent({
    environmentId,
    providerId: provider.id,
    profileId: "development",
    profileSnapshot: {
      settings: { provider: "azure", ttl: "60m", idleTimeout: "30m", warmImage: false },
    },
    provisionOperationId: `provision:v2:${"0".repeat(64)}`,
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  await store.transition({
    environmentId,
    from: "provisioning",
    to: "draining",
    patch: { leaseId, sharedHost: false },
  });
  const warn = vi.fn();
  const service = support.createService(provider, { logger: { warn } });
  await expect(service.reclaim(environmentId)).rejects.toThrow(failure);
  expect(store.get(environmentId)).toMatchObject({
    state: "destroying",
    lastError: expect.stringContaining("exit code 5"),
  });

  await service.reconcileOnce();
  await service.reconcileOnce();
  expect(store.get(environmentId)?.state).toBe("destroying");
  expect(warn.mock.calls.filter(([message]) => message.includes("exit code 5"))).toHaveLength(1);

  cleanupPending = false;
  await service.reconcileOnce();

  expect(store.get(environmentId)).toMatchObject({ state: "destroyed", lastError: null });
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(stop).toHaveBeenCalledTimes(3);
});
