import { expect, it, vi } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  type CommandCall,
  LEASE_ID,
  PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const COLD_PROFILE = { ...PROFILE, warmImage: false };
const COORDINATOR_TIMEOUT = `coordinator read retry 1/4 reason=timeout\ncontext deadline exceeded\nGet "https://coordinator.example/v1/leases/${LEASE_ID}": context deadline exceeded`;
const LEASE_CONFLICT = "lease_id_conflict: fixed claim changed during resolution; retry";
const timeoutResult = (stdout = "") =>
  commandResult({ code: 1, stderr: COORDINATOR_TIMEOUT, stdout });
function scenario(
  command: Parameters<typeof createWarmProvider>[0],
  sleep?: (ms: number) => Promise<void>,
) {
  const { provider, calls } = createWarmProvider(command, undefined, sleep ? { sleep } : {});
  return {
    calls,
    provision: (
      profile: Parameters<typeof provisionWarmProfile>[1] = COLD_PROFILE,
      signal?: AbortSignal,
    ) => provisionWarmProfile(provider, profile, undefined, undefined, { signal }),
  };
}

it("does not retry enrollment after remote script output", async () => {
  let attempts = 0;
  const { provision, calls } = scenario(({ argv }) => {
    if (argv[1] === "run" && ++attempts <= 2) {
      return timeoutResult("CRABBOX_PHASE:openclaw-bootstrap-start");
    }
    return undefined;
  });
  await expect(provision()).rejects.toThrow("Crabbox node enrollment setup failed");
  expectCommands(calls, { run: 1, warmup: 1, stop: 1 });
});

it("retries a profile setup lease conflict using the same fixed lease", async () => {
  const setup = "install-node";
  let attempts = 0;
  const { provision, calls } = scenario(({ options }) =>
    options.input === setup && attempts++ === 0
      ? commandResult({ code: 4, stderr: LEASE_CONFLICT })
      : undefined,
  );
  await expect(provision({ ...COLD_PROFILE, setup })).resolves.toMatchObject({
    leaseId: LEASE_ID,
    node: { deviceId: "device-1" },
  });
  const setups = calls.filter(({ options }) => options.input === setup);
  expect(setups).toHaveLength(2);
  expect(setups.every(({ argv }) => argv[argv.indexOf("--id") + 1] === LEASE_ID)).toBe(true);
  expectCommands(calls, { warmup: 1, stop: 0 });
});

it.each([
  { name: "coordinator timeout", result: timeoutResult() },
  {
    name: "lease conflict",
    result: commandResult({ code: 4, stderr: "lease_id_conflict: claim is still changing" }),
  },
])("stops the lease after exhausting profile setup retries: $name", async ({ result }) => {
  const setup = "install-node";
  const sleep = vi.fn(async (_ms: number) => {});
  const { provision, calls } = scenario(
    ({ options }) => (options.input === setup ? result : undefined),
    sleep,
  );
  await expect(provision({ ...COLD_PROFILE, setup })).rejects.toMatchObject({
    code: "cleanup_complete",
    message: expect.stringContaining(`${result.stderr.replaceAll("\n", " ")} (after 3 attempts)`),
  });
  expectCommands(calls, { warmup: 1, stop: 1 });
  const setups = calls.filter(({ options }) => options.input === setup);
  expect(setups).toHaveLength(3);
  expect(
    setups.every(({ argv }) => argv.includes(LEASE_ID) && argv.includes("--script-stdin")),
  ).toBe(true);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
});

it.each([
  { name: "another exit-4 failure", code: 4, stderr: "lease_unavailable: retry" },
  { name: "a different exit code", code: 1, stderr: LEASE_CONFLICT },
  { name: "a different code token", code: 4, stderr: "lease_id_conflict_other: retry" },
  { name: "script stdout", code: 4, stderr: LEASE_CONFLICT, stdout: "installing packages" },
  { name: "mixed stderr", code: 4, stderr: `${LEASE_CONFLICT}\ninstallation failed` },
])("does not retry profile setup after $name", async ({ name: _name, ...failure }) => {
  const setup = "install-node";
  const { provision, calls } = scenario(({ options }) =>
    options.input === setup ? commandResult(failure) : undefined,
  );
  await expect(provision({ ...COLD_PROFILE, setup })).rejects.toMatchObject({
    code: "cleanup_complete",
    message: expect.stringContaining("Crabbox profile setup failed"),
  });
  expect(calls.filter(({ options }) => options.input === setup)).toHaveLength(1);
  expectCommands(calls, { stop: 1 });
});

it("cancels backoff without resubmitting setup or stopping the lease", async () => {
  const controller = new AbortController();
  const { provision, calls } = scenario(
    ({ argv }) => (argv[1] === "run" ? timeoutResult() : undefined),
    async () => {
      controller.abort();
    },
  );
  await expect(
    provision({ ...COLD_PROFILE, setup: "install-node" }, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
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
