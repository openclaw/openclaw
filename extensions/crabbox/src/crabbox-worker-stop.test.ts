import { describe, expect, it, vi } from "vitest";
import {
  commandResult,
  createWarmProvider,
  LEASE_ID,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

const lease = { leaseId: LEASE_ID, profile: { ...PROFILE, warmImage: false } };

describe("Crabbox worker stop confirmation", () => {
  it.each([
    {
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    { code: 4, stderr: `lease/server not found: ${LEASE_ID}` },
    { code: 4, stderr: `lease ${LEASE_ID} already stopped` },
  ])("rejects unproven stop despite misleading prose: $stderr", async ({ code, stderr }) => {
    const { provider, calls } = createWarmProvider(() => commandResult({ code, stderr }));
    await expect(provider.destroy(lease)).rejects.toThrow(`stop failed with exit code ${code}`);
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });

  it("keeps a dual-404 stop outcome unknown without a structured absence receipt", async () => {
    const runCommand = vi.fn(async () =>
      commandResult({
        code: 1,
        stderr:
          `warning: could not inspect lease before release: coordinator GET /v1/leases/${LEASE_ID}: http 404: {"error":"not_found"}\n` +
          `coordinator POST /v1/leases/${LEASE_ID}/release: http 404: {"error":"not_found"}`,
      }),
    );
    const { provider } = createWarmProvider(runCommand);
    await expect(provider.destroy(lease)).rejects.toThrow("stop failed with exit code 1");
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("accepts producer-confirmed absence only after a normal successful stop", async () => {
    const { provider, calls } = createWarmProvider(() => commandResult());
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    await expect(provider.destroy(lease)).resolves.toBeUndefined();
    expect(calls.map(({ argv }) => argv)).toEqual([
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
      ["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});
