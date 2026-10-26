import { expect, it, vi } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  type CommandCall,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const COLD_PROFILE = { ...PROFILE, warmImage: false, setup: "install-node" };
const COORDINATOR_TIMEOUT = `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\nGet "https://coordinator.example/v1/leases/${LEASE_ID}": context deadline exceeded`;
const LEASE_CONFLICT = "lease_id_conflict: fixed claim changed during resolution; retry";
const timeoutResult = () => commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT });
const conflictResult = (overrides: Parameters<typeof commandResult>[0] = {}) =>
  commandResult({ code: 4, stderr: LEASE_CONFLICT, ...overrides });
function scenario(
  command: Parameters<typeof createWarmProvider>[0],
  sleep?: (ms: number) => Promise<void>,
) {
  const { provider, calls } = createWarmProvider(command, undefined, sleep ? { sleep } : {});
  return {
    calls,
    provision: (signal?: AbortSignal) =>
      provisionWarmProfile(provider, COLD_PROFILE, undefined, undefined, { signal }),
  };
}

it.each([
  ["lease conflict resolves", conflictResult(), 2],
  ["lease conflict persists", conflictResult(), 3],
  ["coordinator timeout persists", timeoutResult(), 3],
  ["different exit code", conflictResult({ code: 1 }), 1],
  ["different token", conflictResult({ stderr: "lease_id_conflict_other: retry" }), 1],
  ["script stdout", conflictResult({ stdout: "installing packages" }), 1],
  ["mixed stderr", conflictResult({ stderr: `${LEASE_CONFLICT}\ninstallation failed` }), 1],
] as const)("bounds fixed-lease setup retries: %s", async (_name, result, count) => {
  let attempts = 0;
  const sleep = vi.fn(async (_ms: number) => {});
  const { provision, calls } = scenario(
    ({ options }) =>
      options.input === COLD_PROFILE.setup && (count !== 2 || attempts++ === 0)
        ? result
        : undefined,
    sleep,
  );
  const operation = provision();
  if (count === 2) {
    await expect(operation).resolves.toMatchObject({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
    });
  } else {
    await expect(operation).rejects.toMatchObject({
      code: "cleanup_complete",
      message: expect.stringContaining(
        count === 3
          ? `${result.stderr.replaceAll("\n", " ")} (after 3 attempts)`
          : "Crabbox profile setup failed",
      ),
    });
  }
  expectCommands(calls, { warmup: 1, stop: count === 2 ? 0 : 1 });
  const setups = calls.filter(({ options }) => options.input === COLD_PROFILE.setup);
  expect(setups).toHaveLength(count);
  expect(setups.every(({ argv }) => argv[argv.indexOf("--id") + 1] === LEASE_ID)).toBe(true);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000].slice(0, count - 1));
});

it("cancels backoff without resubmitting setup or stopping the lease", async () => {
  const controller = new AbortController();
  const { provision, calls } = scenario(
    ({ argv }) => (argv[1] === "run" ? timeoutResult() : undefined),
    async () => {
      controller.abort();
    },
  );
  await expect(provision(controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expectCommands(calls, { run: 1, stop: 0 });
});

it("does not retry warmup coordinator timeouts", async () => {
  const { provision, calls } = scenario(({ argv }) =>
    argv[1] === "warmup" ? timeoutResult() : undefined,
  );
  await expect(provision()).rejects.toThrow("Crabbox warmup failed");
  expectCommands(calls, { warmup: 1, run: 0, stop: 0 });
});

function expectCommands(calls: CommandCall[], counts: Record<string, number>) {
  for (const [command, count] of Object.entries(counts)) {
    expect(calls.filter(({ argv }) => argv[1] === command)).toHaveLength(count);
  }
}
