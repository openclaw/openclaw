import { expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { runProvisionSetup } from "./crabbox-worker-provision-commands.js";

const state = vi.hoisted(() => ({ current: true, dispatch: vi.fn() }));
vi.mock("./crabbox-process.js", () => ({ runCrabboxProcess: state.dispatch }));
// Keep the real profile creation/cleanup; revoke admission after its awaited
// write and before its callback dispatches a runtime setup/scrub command.
vi.mock("./crabbox-worker-env-profile.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./crabbox-worker-env-profile.js")>();
  const withCrabboxWorkerEnvProfile: typeof original.withCrabboxWorkerEnvProfile = (env, run) =>
    original.withCrabboxWorkerEnvProfile(env, (...args) => {
      state.current = false;
      return run(...args);
    });
  return { ...original, withCrabboxWorkerEnvProfile };
});

it.each(["node runtime preparation", "node enrollment setup"])(
  "rechecks admission after the forwarded profile is created: %s",
  async (phase) => {
    state.current = true;
    state.dispatch.mockReset().mockResolvedValue(commandResult());
    const assertCurrent = () => {
      if (!state.current) {
        throw new Error("source admission revoked");
      }
    };
    await expect(
      runProvisionSetup({
        binary: "crabbox",
        provider: "azure-sandbox",
        inspect: { id: "worker-test", ready: true, state: "running", tailscaleEnabled: false },
        deadline: performance.now() + 10_000,
        profile: parseCrabboxProfile({ provider: "azure-sandbox", ttl: "1h", idleTimeout: "10m" }),
        stopLease: async () => {},
        phase,
        setup: "fixture",
        forwardedEnv: { CRABBOX_WORKER_BOOTSTRAP_TOKEN: "synthetic-not-a-real-grant" },
        assertCurrent,
      }),
    ).rejects.toThrow("source admission revoked");
    expect(state.dispatch).not.toHaveBeenCalled();
  },
);
