import { expect, it, vi } from "vitest";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import { runProvisionSetup } from "./crabbox-worker-provision-commands.js";

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
// mock-isolation: capture the logger boundary without changing provisioning or parsing.
vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>()),
  createSubsystemLogger: () => logs,
}));
// mock-isolation: the remote process supplies fixed stdout/stderr; setup consumes it normally.
vi.mock("./crabbox-process.js", () => ({
  runCrabboxProcess: async () => ({
    stdout: "unrelated output must not be logged",
    stderr:
      "CRABBOX_TIMING:openclaw-bootstrap-download-body:125\r\nCRABBOX_TIMING:openclaw-bootstrap-installation:900\nCRABBOX_WARNING:openclaw-bootstrap-unlocked-install:lock unavailable from Gateway\nCRABBOX_TIMING:invalid-secret:123\n",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  }),
}));

it("logs successful bootstrap durations and fallback warnings without forwarding process output", async () => {
  await runProvisionSetup({
    binary: "crabbox",
    provider: "aws",
    inspect: { id: "worker-test", ready: true, state: "running", tailscaleEnabled: false },
    deadline: Date.now() + 10_000,
    profile: parseCrabboxProfile({ provider: "aws", ttl: "1h", idleTimeout: "10m" }),
    stopLease: async () => {},
    phase: "node enrollment setup",
    setup: "fixture",
  });
  expect(logs.info.mock.calls).toEqual([
    ["Cloud worker worker-test: openclaw-bootstrap-download-body 125ms"],
    ["Cloud worker worker-test: openclaw-bootstrap-installation 900ms"],
  ]);
  expect(logs.warn.mock.calls).toEqual([
    ["Cloud worker worker-test: using unlocked runtime install (lock unavailable from Gateway)"],
  ]);
});
