import { expect, it, vi } from "vitest";
import {
  OPERATION_ID,
  LEASE_ID,
  SIBLING_BINARY,
  PROFILE,
  lifecycleLease,
  heartbeatFixture,
} from "./crabbox-worker-provider-fixture.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));

it.each([
  { backend: "aws", idleTimeout: "1s", interval: 500, timeout: 500 },
  { backend: "aws", idleTimeout: "12s", interval: 5_000, timeout: 6_000 },
  { backend: "aws", idleTimeout: "30s", interval: 10_000, timeout: 15_000 },
  { backend: "aws", idleTimeout: "6m", interval: 60_000, timeout: 150_000 },
  { backend: "azure-sandbox", idleTimeout: "15m", interval: 60_000, timeout: 150_000 },
])(
  "renews before idle expiry ($backend $idleTimeout)",
  async ({ backend, idleTimeout, interval, timeout }) => {
    const { provider, heartbeat, runCommand, warnings } = heartbeatFixture(async () =>
      commandResult(),
    );
    const profile = { ...PROFILE, provider: backend, idleTimeout };
    try {
      await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledExactlyOnceWith(
        [
          SIBLING_BINARY,
          "heartbeat",
          "--provider",
          backend,
          "--id",
          LEASE_ID,
          ...(backend === "azure-sandbox" ? [] : ["--idle-timeout", idleTimeout]),
          "--json",
        ],
        expect.objectContaining({ timeoutMs: timeout }),
      );
      await vi.advanceTimersByTimeAsync(interval - 1);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      const create = runCommand.mock.calls.find(([argv]) => argv.includes("--lease-id"));
      expect(create?.[0]).toEqual(expect.arrayContaining(["--idle-timeout", idleTimeout]));
      expect(warnings).toEqual([]);
    } finally {
      await provider.destroy(lifecycleLease(LEASE_ID, profile));
      vi.useRealTimers();
    }
  },
);
