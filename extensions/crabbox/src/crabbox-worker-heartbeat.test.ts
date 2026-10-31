import { beforeEach, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  commandResult,
  createProviderTestHarness,
  nodeEnrollmentFixture,
} from "./crabbox-worker-provider.test-support.js";

vi.mock("./crabbox-managed-binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./crabbox-managed-binary.js")>()),
  ensureManagedCrabboxBinary: vi.fn(),
}));
const LEASE_ID = "cbx_6071fc2062a6";
const PROFILE = { provider: "aws", ttl: "4h", idleTimeout: "60m", warmImage: false };
const { createProvider } = createProviderTestHarness({}, "openclaw-crabbox-heartbeat-");
beforeEach(() => {
  vi.mocked(ensureManagedCrabboxBinary).mockImplementation(async () => ({
    binary: "/fixture/crabbox",
    version: "999.0.0",
  }));
});
function inspectJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: LEASE_ID, state: "active", ready: true, ...overrides });
}
function lifecycleLease(leaseId = LEASE_ID) {
  return { leaseId, profile: PROFILE };
}
function heartbeatFixture(run: CrabboxCommandRunner, inspect = () => inspectJson()) {
  vi.useFakeTimers();
  const heartbeat = vi.fn(run);
  const warnings: string[] = [];
  const provider = createProvider({
    runCommand: async (argv, options) =>
      argv[1] === "heartbeat"
        ? heartbeat(argv, options)
        : commandResult({ stdout: argv[1] === "inspect" ? inspect() : "" }),
    warn: (message) => warnings.push(message),
  });
  return { provider, heartbeat, warnings };
}
it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
  const runCommand = vi.fn<CrabboxCommandRunner>();
  const provider = createProvider({ runCommand });
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
  await provider.destroy(lifecycleLease());
});

it("re-arms a pending heartbeat when inspection shortens the idle window", async () => {
  let idleTimeout = "60m";
  const { provider, heartbeat } = heartbeatFixture(
    async () => commandResult(),
    () => inspectJson({ idleTimeout }),
  );
  await provider.inspect(lifecycleLease());
  await vi.advanceTimersByTimeAsync(0);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  idleTimeout = "6s";
  await provider.inspect(lifecycleLease());
  await vi.advanceTimersByTimeAsync(3000);
  expect(heartbeat).toHaveBeenCalledTimes(2);
  await provider.destroy(lifecycleLease());
});

it("refreshes Sandbox activity without requesting an idle policy replacement", async () => {
  const { provider, heartbeat, warnings } = heartbeatFixture(async (argv) =>
    argv.includes("--idle-timeout")
      ? commandResult({
          code: 2,
          stderr:
            "provider=azure-sandbox does not support replacing the lease idle timeout while heartbeating",
        })
      : commandResult({
          stdout: JSON.stringify({ id: LEASE_ID, provider: "azure-sandbox", state: "Running" }),
        }),
  );
  const profile = { ...PROFILE, provider: "azure-sandbox", class: "small" };
  try {
    await provider.provision(profile, `provision:v2:${"0".repeat(64)}`, {
      assertCurrent: () => {},
      beginNodeEnrollment: async () => nodeEnrollmentFixture("fixture-setup-code", "Sandbox test"),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([]);
    heartbeat.mockImplementationOnce(async () => commandResult({ code: 1, stderr: "unavailable" }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warnings).toEqual([
      "Crabbox heartbeat failed with exit code 1: unavailable; Sandbox idle activity is not being refreshed; OpenClaw will retry automatically; save your work if failures persist",
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(4);
    expect(warnings).toHaveLength(1);
    heartbeat.mockImplementationOnce(async () =>
      commandResult({ code: 2, stderr: "provider=azure-sandbox does not support lease heartbeat" }),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(warnings.at(-1)).toBe(
      `Crabbox provider azure-sandbox does not support heartbeat for worker lease ${LEASE_ID}; Sandbox idle activity is not being refreshed; save your work if failures persist`,
    );
  } finally {
    await provider.destroy({ leaseId: LEASE_ID, profile });
    vi.useRealTimers();
  }
});
