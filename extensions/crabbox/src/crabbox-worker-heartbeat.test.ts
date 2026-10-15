import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { commandResult, createProviderFixtures } from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crabbox-managed-binary.js")>()),
  ensureManagedCrabboxBinary: vi.fn(),
}));
const LEASE_ID = "cbx_6071fc2062a6";
const PROFILE = { provider: "aws", ttl: "4h", idleTimeout: "60m", warmImage: false };
const { providers, createProvider } = createProviderFixtures();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await Promise.all([...providers].map((provider) => provider.dispose()));
    providers.clear();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    cleanup();
  }),
);
beforeEach(() => {
  vi.mocked(ensureManagedCrabboxBinary).mockImplementation(async () => ({
    binary: "/fixture/crabbox",
    version: "999.0.0",
  }));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-heartbeat-"));
});
function inspectJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: LEASE_ID, state: "active", ready: true, ...overrides });
}
function lifecycleLease(leaseId = LEASE_ID) {
  return { leaseId, profile: PROFILE };
}
function providerWithRunner(runCommand: CrabboxCommandRunner, warn?: (message: string) => void) {
  return createProvider({ runCommand, warn });
}
function heartbeatFixture(run: CrabboxCommandRunner) {
  vi.useFakeTimers();
  const heartbeat = vi.fn(run);
  const warnings: string[] = [];
  const provider = providerWithRunner(
    async (argv, options) =>
      argv[1] === "heartbeat"
        ? heartbeat(argv, options)
        : commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" }),
    (message) => warnings.push(message),
  );
  return { provider, heartbeat, warnings };
}
describe("Crabbox heartbeat lifecycle", () => {
  it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);
    const lease = lifecycleLease("lease:not-crabbox");

    await expect(provider.inspect(lease)).rejects.toThrow("lease id is invalid");
    await expect(provider.destroy(lease)).rejects.toThrow("lease id is invalid");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("adopts shortened effective idle policy and surfaces successful heartbeat notices", async () => {
    let attempts = 0;
    const { provider, heartbeat, warnings } = heartbeatFixture(async () => {
      attempts++;
      return commandResult({
        stdout: inspectJson({
          idleTimeout: attempts === 1 ? "6s" : "3s",
          expiresAt: "2026-10-13T12:30:00Z",
        }),
        stderr: "Lease policy clamped idle timeout.",
      });
    });
    try {
      await provider.inspect(lifecycleLease());
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([
        `Crabbox worker lease ${LEASE_ID}: Lease policy clamped idle timeout.`,
      ]);
      await vi.advanceTimersByTimeAsync(2999);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(heartbeat.mock.calls[1]?.[1].timeoutMs).toBe(3000);
      await vi.advanceTimersByTimeAsync(1500);
      expect(heartbeat).toHaveBeenCalledTimes(3);
      expect(warnings).toHaveLength(1);
    } finally {
      await provider.destroy(lifecycleLease());
      vi.useRealTimers();
    }
  });

  it("re-arms a pending heartbeat when inspection shortens the idle window", async () => {
    vi.useFakeTimers();
    let idleTimeout = "60m";
    const heartbeat = vi.fn();
    const provider = providerWithRunner(async (argv) => {
      if (argv[1] === "heartbeat") {
        heartbeat();
      }
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson({ idleTimeout }) : "" });
    });
    try {
      await provider.inspect(lifecycleLease());
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      idleTimeout = "6s";
      await provider.inspect(lifecycleLease());
      await vi.advanceTimersByTimeAsync(3000);
      expect(heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      await provider.destroy(lifecycleLease());
      vi.useRealTimers();
    }
  });
});
