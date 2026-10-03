import { describe, expect, it, vi } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const COLD_PROFILE = { ...PROFILE, warmImage: false };
const COORDINATOR_TIMEOUT = `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\nGet "https://coordinator.example/v1/leases/${LEASE_ID}": context deadline exceeded`;

describe("Crabbox worker coordinator retries", () => {
  it.each(["", "CRABBOX_PHASE:openclaw-bootstrap-start"])(
    "retries enrollment only before script output %j",
    async (stdout) => {
      let attempts = 0;
      const { provider, calls } = createWarmProvider(({ argv }) => {
        if (argv[1] === "run" && ++attempts <= 2) {
          return commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT, stdout });
        }
        return undefined;
      });
      const provisioning = provisionWarmProfile(provider, COLD_PROFILE);
      if (stdout) {
        await expect(provisioning).rejects.toThrow("Crabbox node enrollment setup failed");
      } else {
        await expect(provisioning).resolves.toMatchObject({ leaseId: LEASE_ID });
      }
      const scripts = calls.filter(({ argv }) => argv[1] === "run");
      expect(scripts).toHaveLength(stdout ? 1 : 3);
      expect(new Set(scripts.map(({ options }) => options.input)).size).toBe(1);
      expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(stdout ? 1 : 0);
    },
  );

  it.each(["recovers", "exhausted", "script error"])(
    "submits profile setup until %s",
    async (outcome) => {
      const setup = "install-node";
      let submissions = 0;
      const sleep = vi.fn(async (_ms: number) => {});
      const { provider, calls } = createWarmProvider(
        ({ options }) => {
          if (options.input !== setup) {
            return undefined;
          }
          submissions += 1;
          if (outcome === "script error") {
            return commandResult({ code: 7, stderr: "apt failed" });
          }
          return submissions <= 2 || outcome === "exhausted"
            ? commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT })
            : commandResult();
        },
        undefined,
        { sleep },
      );
      const provisioning = provisionWarmProfile(provider, { ...COLD_PROFILE, setup });
      if (outcome === "recovers") {
        await expect(provisioning).resolves.toMatchObject({ leaseId: LEASE_ID });
      } else {
        await expect(provisioning).rejects.toMatchObject({
          code: "cleanup_complete",
          message:
            outcome === "exhausted"
              ? expect.stringMatching(/Get .*context deadline exceeded.*after 3 attempts/s)
              : expect.stringContaining("profile setup failed with exit code 7: apt failed"),
        });
      }
      expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(
        outcome === "recovers" ? 0 : 1,
      );
      const setups = calls.filter(({ options }) => options.input === setup);
      expect(setups).toHaveLength(outcome === "script error" ? 1 : 3);
      expect(
        setups.every(({ argv }) => argv.includes(LEASE_ID) && argv.includes("--script-stdin")),
      ).toBe(true);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
        outcome === "script error" ? [] : [1_000, 2_000],
      );
    },
  );

  it("cancels backoff without resubmitting setup or stopping the lease", async () => {
    const controller = new AbortController();
    const { provider, calls } = createWarmProvider(
      ({ argv }) =>
        argv[1] === "run" ? commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT }) : undefined,
      undefined,
      {
        sleep: async () => {
          controller.abort();
        },
      },
    );
    await expect(
      provisionWarmProfile(
        provider,
        { ...COLD_PROFILE, setup: "install-node" },
        undefined,
        undefined,
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter(({ argv }) => argv[1] === "run")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each(["initial", "readiness", "lifecycle"])("recovers during %s inspection", async (phase) => {
    let inspections = 0;
    const sleep = vi.fn(async (_ms: number) => {});
    const { provider } = createWarmProvider(
      ({ argv }) => {
        if (argv[1] !== "inspect") {
          return undefined;
        }
        inspections += 1;
        if (inspections === (phase === "readiness" ? 2 : 1)) {
          return commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT });
        }
        return commandResult({
          stdout: JSON.stringify({
            id: LEASE_ID,
            state: "running",
            ready: phase !== "readiness" || inspections > 2,
            providerMetadata: { instanceProfileAttached: false },
          }),
        });
      },
      undefined,
      { sleep },
    );
    if (phase === "lifecycle") {
      await expect(provider.inspect({ leaseId: LEASE_ID, profile: COLD_PROFILE })).resolves.toEqual(
        { status: "active", sharedHost: false },
      );
    } else {
      await expect(provisionWarmProfile(provider, COLD_PROFILE)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
    }
    expect(inspections).toBe(phase === "readiness" ? 3 : 2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
      phase === "readiness" ? [2_000, 1_000] : [1_000],
    );
  });

  it("does not retry warmup coordinator timeouts", async () => {
    const { provider, calls } = createWarmProvider(({ argv }) =>
      argv[1] === "warmup" ? commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT }) : undefined,
    );
    await expect(provisionWarmProfile(provider, COLD_PROFILE)).rejects.toThrow(
      "Crabbox warmup failed",
    );
    expect(calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(1);
    expect(calls.some(({ argv }) => argv[1] === "run" || argv[1] === "stop")).toBe(false);
  });

  it("recovers heartbeat before warning", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const { provider, warn } = createWarmProvider(({ argv }) => {
      if (argv[1] === "heartbeat" && ++attempts < 3) {
        return commandResult({
          code: 1,
          stderr: `Post "https://coordinator.example/v1/leases/${LEASE_ID}/heartbeat": context deadline exceeded`,
        });
      }
      return undefined;
    });
    try {
      await provider.inspect({ leaseId: LEASE_ID, profile: COLD_PROFILE });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await provider.dispose();
      vi.useRealTimers();
    }
  });
});
