import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const lease = { leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } };

describe("Crabbox worker stop confirmation", () => {
  it.for(["direct stop", "capture"] as const)(
    "retains destroy confirmation while waiting for %s",
    async (phase, { signal }) => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (phase === "direct stop" && argv.includes("--wait=false")) {
          return commandResult({
            code: 2,
            stderr: "--wait=false requires an ordinary coordinator-backed stop",
          });
        }
        if (
          phase === "direct stop"
            ? argv[1] === "stop"
            : argv[1] === "checkpoint" && argv[2] === "create"
        ) {
          started.resolve();
          await withinTest(finish.promise, signal);
        }
        return undefined;
      });
      const pendingLease =
        phase === "capture"
          ? { ...(await provisionWarmProfile(provider)), profile: PROFILE }
          : lease;
      vi.useFakeTimers();
      const accepted = vi.fn();
      const returned = vi.fn();
      const destroy = provider
        .destroy({ ...pendingLease, onCleanupAccepted: accepted })
        .then(returned);
      try {
        await withinTest(started.promise, signal);
        await vi.advanceTimersByTimeAsync(0);
        expect(accepted).toHaveBeenCalledTimes(phase === "capture" ? 1 : 0);
        expect(returned).not.toHaveBeenCalled();
        if (phase === "capture") {
          expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
        }
      } finally {
        finish.resolve();
        await destroy;
        vi.useRealTimers();
      }
      expect(calls.at(-1)?.argv).toEqual([
        "crabbox",
        "stop",
        "--provider",
        "aws",
        "--id",
        LEASE_ID,
      ]);
    },
  );

  it.each([
    {
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    { code: 4, stderr: `lease ${LEASE_ID} already stopped` },
  ])("rejects unproven stop despite misleading prose: $stderr", async ({ code, stderr }) => {
    const { provider } = createWarmProvider(() => commandResult({ code, stderr }));
    await expect(provider.destroy(lease)).rejects.toThrow(`stop failed with exit code ${code}`);
  });

  it("completes destroy and releases warm allocation ownership for a never-admitted lease", async () => {
    const inspectError = `coordinator GET /v1/leases/${LEASE_ID}: http 404: {"error":"not_found"}`;
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[1] === "warmup") {
        return commandResult({ code: 1, stderr: "allocation not admitted" });
      }
      if (argv[1] === "inspect") {
        return commandResult({ code: 1, stderr: inspectError });
      }
      if (argv[1] === "stop") {
        return commandResult({
          code: 1,
          stderr:
            `warning: could not inspect lease before release: ${inspectError}\n` +
            `coordinator POST /v1/leases/${LEASE_ID}/release: http 404: {"error":"not_found"}`,
        });
      }
      return undefined;
    });
    await expect(provisionWarmProfile(provider)).rejects.toThrow("warmup failed");
    const store = openWarmImageStore();
    const owner = store.entries()[0]!;
    expect(owner.value.allocations[LEASE_ID]).toBeDefined();
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "unknown" });
    await expect(provider.destroy({ ...lease, profile: PROFILE })).resolves.toBeUndefined();
    expect(store.lookup(owner.key)?.allocations[LEASE_ID]).toBeUndefined();
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
  });
});
