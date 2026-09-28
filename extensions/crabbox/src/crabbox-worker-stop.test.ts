import { describe, expect, it } from "vitest";
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
  it.each([
    {
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    { code: 4, stderr: `lease ${LEASE_ID} already stopped` },
  ])("rejects unproven stop despite misleading prose: $stderr", async ({ code, stderr }) => {
    const { provider, calls } = createWarmProvider(() => commandResult({ code, stderr }));
    await expect(provider.destroy(lease)).rejects.toThrow(`stop failed with exit code ${code}`);
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });

  it("completes destroy and releases warm allocation ownership for a never-admitted lease", async () => {
    const inspectError = `coordinator GET /v1/leases/${LEASE_ID}: http 404: {"error":"not_found"}`;
    const { provider, calls, warn } = createWarmProvider(({ argv }) => {
      if (argv[1] === "warmup") {
        return commandResult({ code: 1, stderr: "allocation not admitted" });
      }
      if (argv[1] === "inspect") {
        return commandResult({ code: 1, stderr: inspectError });
      }
      if (argv[1] === "stop") {
        // Crabbox 0.67.0 output, with the captured lease ID replaced by the fixture's ID.
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
    expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `Crabbox lease ${LEASE_ID} (provider aws) is absent; treating stop as already released`,
    );
  });

  it("accepts a normal successful stop repeatedly", async () => {
    const { provider, calls } = createWarmProvider(() => commandResult());
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});
