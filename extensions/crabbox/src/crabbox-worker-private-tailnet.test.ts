import { syncBuiltinESMExports } from "node:module";
import { parseArgs } from "node:util";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  active,
  commandResult,
  catalogJson,
  classProfile,
  createProviderFixtures,
  nodeEnrollmentFixture,
} from "./crabbox-worker-provider.test-support.js";

// mock-isolation: Provider-boundary proof uses synthetic CLI I/O, not live leases.
vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = "cbx_6071fc2062a6";
const PROFILE = {
  provider: "aws",
  class: "standard",
  ttl: "24h",
  idleTimeout: "60m",
  warmImage: false,
};
type ProvisionOptions = Parameters<WorkerProvider["provision"]>[2];
const { providers, createProvider } = createProviderFixtures({ sleep: async () => {} });
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...providers].map((provider) => provider.dispose()));
    } finally {
      providers.clear();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      vi.unstubAllEnvs();
      vi.useRealTimers();
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      cleanup();
    }
  }),
);
beforeEach(() => {
  vi.mocked(ensureManagedCrabboxBinary).mockImplementation(async (params) => ({
    binary: params?.binary ?? "crabbox",
    version: "999.0.0",
  }));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-tailnet-"));
});
function inspectJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: LEASE_ID, state: "running", ready: true, ...overrides });
}
function readyResult(argv: string[], overrides: Record<string, unknown> = {}) {
  return commandResult({ stdout: argv[1] === "inspect" ? inspectJson(overrides) : "" });
}
function lifecycleLease(leaseId: string, profile: WorkerProfile) {
  return { leaseId, profile };
}
function providerWithRunner(runCommand: CrabboxCommandRunner) {
  const provider = createProvider({
    runCommand: async (argv, options) => {
      if (argv[1] === "config") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return runCommand(argv, options);
    },
  });
  return {
    ...provider,
    provision: (profile: WorkerProfile, operationId = OPERATION_ID, options?: ProvisionOptions) =>
      provider.provision(profile, operationId, {
        assertCurrent() {},
        beginNodeEnrollment: async () => nodeEnrollmentFixture("synthetic-setup", "Private worker"),
        ...options,
      }),
  };
}
function recordedProvider(script: CrabboxCommandRunner | Record<string, SpawnResult>) {
  const calls: string[][] = [];
  const provider = providerWithRunner(async (argv, options) => {
    calls.push(argv);
    return typeof script === "function"
      ? script(argv, options)
      : (script[argv[1]!] ?? readyResult(argv));
  });
  return { provider, calls };
}

const TAILNET_PROFILE = { ...PROFILE, provider: "proxmox", network: "tailscale" };
const TAILNET_INSPECT = {
  network: "tailscale",
  tailscale: { enabled: true, state: "ready", ipv4: "100.64.0.10", deviceID: "nFixtureDevice" },
};

it("uses one private lease across cold provisioning, fresh provider replay, inspection and teardown", async () => {
  const calls: string[][] = [];
  const run: CrabboxCommandRunner = async (argv) => {
    calls.push(argv);
    return readyResult(argv, TAILNET_INSPECT);
  };
  const first = providerWithRunner(run);
  await expect(
    first.provision({ ...TAILNET_PROFILE, setup: "install-node" }),
  ).resolves.toMatchObject({
    leaseId: LEASE_ID,
    node: { deviceId: "device-1" },
  });
  await first.dispose();
  const replay = providerWithRunner(run);
  await expect(
    replay.provision({ ...TAILNET_PROFILE, setup: "install-node" }),
  ).resolves.toMatchObject({ leaseId: LEASE_ID });
  await expect(replay.inspect(lifecycleLease(LEASE_ID, TAILNET_PROFILE))).resolves.toEqual(active);
  await replay.destroy(lifecycleLease(LEASE_ID, TAILNET_PROFILE));
  for (const argv of calls.filter((args) => ["warmup", "inspect", "run"].includes(args[1]!))) {
    expect(argv[argv.indexOf("--network") + 1]).toBe("tailscale");
    expect(argv).not.toContain("public");
    expect(argv).not.toContain("--tailscale=false");
    expect(argv[argv.indexOf(argv[1] === "warmup" ? "--lease-id" : "--id") + 1]).toBe(LEASE_ID);
    if (argv[1] !== "inspect") {
      expect(argv).toContain("--tailscale");
    }
  }
  expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(2);
  expect(calls.some((argv) => argv[1] === "checkpoint")).toBe(false);
  expect(calls.at(-1)?.slice(1)).toEqual(["stop", "--provider", "proxmox", "--id", LEASE_ID]);
});

it("waits for private readiness before any setup or enrollment", async () => {
  let inspections = 0;
  const events: string[] = [];
  const provider = providerWithRunner(async (argv) => {
    events.push(argv[1]!);
    const pending = argv[1] === "inspect" && inspections++ === 0;
    return readyResult(argv, { ...TAILNET_INSPECT, ...(pending ? { ready: false } : {}) });
  });
  await expect(provider.provision(TAILNET_PROFILE)).resolves.toMatchObject({ leaseId: LEASE_ID });
  expect(events.slice(0, 3)).toEqual(["warmup", "inspect", "inspect"]);
  expect(events.indexOf("run")).toBeGreaterThan(2);
});

it.each([
  ["missing metadata", { tailscale: undefined }],
  ["disabled", { tailscale: { ...TAILNET_INSPECT.tailscale, enabled: false } }],
  ["failed", { tailscale: { ...TAILNET_INSPECT.tailscale, state: "failed" } }],
  ["error", { tailscale: { ...TAILNET_INSPECT.tailscale, error: "join failed" } }],
  ["missing device", { tailscale: { ...TAILNET_INSPECT.tailscale, deviceID: undefined } }],
  ["invalid device", { tailscale: { ...TAILNET_INSPECT.tailscale, deviceID: " " } }],
  ["wrong device type", { tailscale: { ...TAILNET_INSPECT.tailscale, deviceID: 123 } }],
  ["LAN address", { tailscale: { ...TAILNET_INSPECT.tailscale, ipv4: "10.0.0.10" } }],
  ["outside CGNAT", { tailscale: { ...TAILNET_INSPECT.tailscale, ipv4: "100.128.0.1" } }],
  ["invalid IPv4", { tailscale: { ...TAILNET_INSPECT.tailscale, ipv4: "100.64.0.999" } }],
  ["public mode", { network: "public" }],
  ["missing mode", { network: undefined }],
  ["wrong lease", { id: "cbx_ffffffffffff" }],
])("cleans up private admission failure: %s", async (_name, patch) => {
  const beginNodeEnrollment = vi.fn();
  const { provider, calls } = recordedProvider(async (argv) =>
    readyResult(argv, { ...TAILNET_INSPECT, ...patch }),
  );
  await expect(
    provider.provision(TAILNET_PROFILE, OPERATION_ID, { beginNodeEnrollment }),
  ).rejects.toMatchObject({ code: "cleanup_complete" });
  expect(beginNodeEnrollment).not.toHaveBeenCalled();
  expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
});

it("rejects drift on post-setup refresh and lifecycle inspect", async () => {
  let inspections = 0;
  const { provider, calls } = recordedProvider(async (argv) =>
    readyResult(argv, {
      ...TAILNET_INSPECT,
      ...(argv[1] === "inspect" && inspections++ > 0 ? { tailscale: { enabled: false } } : {}),
    }),
  );
  await expect(
    provider.provision({ ...TAILNET_PROFILE, setup: "install-node" }),
  ).rejects.toMatchObject({ code: "cleanup_complete" });
  expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect", "stop"]);
  await expect(provider.inspect(lifecycleLease(LEASE_ID, TAILNET_PROFILE))).resolves.toEqual({
    status: "unknown",
  });
});

it("preserves a fixed-policy conflict without allocating a replacement or switching transport", async () => {
  const { provider, calls } = recordedProvider({
    warmup: commandResult({
      code: 4,
      stderr: "lease_id_conflict: immutable network policy changed",
    }),
    inspect: commandResult({ stdout: inspectJson(TAILNET_INSPECT) }),
  });
  await expect(provider.provision(TAILNET_PROFILE)).rejects.toThrow(
    "immutable network policy changed",
  );
  expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(1);
  expect(calls.find((argv) => argv[1] === "warmup")).toContain(LEASE_ID);
  expect(calls.some((argv) => argv.includes("public"))).toBe(false);
});

it("retains private lease custody on setup cancellation and stops the same lease explicitly", async () => {
  const controller = new AbortController();
  const { provider, calls } = recordedProvider(async (argv, options) => {
    if (argv[1] === "run") {
      controller.abort();
      expect(options.signal?.aborted).toBe(true);
      return commandResult({ code: 2, stderr: "interrupted" });
    }
    return readyResult(argv, TAILNET_INSPECT);
  });
  const beginNodeEnrollment = vi.fn();
  await expect(
    provider.provision({ ...TAILNET_PROFILE, setup: "install-node" }, OPERATION_ID, {
      signal: controller.signal,
      beginNodeEnrollment,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(beginNodeEnrollment).not.toHaveBeenCalled();
  expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run"]);
  expect(calls[2]).toContain("tailscale");
  await provider.destroy(lifecycleLease(LEASE_ID, TAILNET_PROFILE));
  expect(calls.at(-1)?.slice(1)).toEqual(["stop", "--provider", "proxmox", "--id", LEASE_ID]);
});

it("preserves public-profile rejection even when the Tailscale object says disabled", async () => {
  const { provider, calls } = recordedProvider(async (argv) =>
    readyResult(argv, { tailscale: { enabled: false } }),
  );
  await expect(provider.provision(PROFILE)).rejects.toMatchObject({
    code: "cleanup_complete",
    message: "Crabbox cloud worker lease must not have Tailscale enabled",
  });
  expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
});

it.each([
  ["disabled Tailscale", { tailscale: { enabled: false } }],
  ["malformed Tailscale", { tailscale: null }],
  ["different lease", { id: "cbx_ffffffffffff" }],
])(
  "withdraws private status and renewal on %s but preserves transport uncertainty",
  async (_name, drift) => {
    vi.useFakeTimers();
    let mode: "ready" | "unavailable" | "drift" = "ready";
    const renewed: string[] = [];
    const { provider, calls } = recordedProvider(async (argv) => {
      if (argv[1] === "heartbeat") {
        // Crabbox 5278730 internal/cli/heartbeat.go: lease-owned renewal has no
        // network flag. Strict parsing makes unsupported options fail before renewal.
        const { values } = parseArgs({
          args: argv.slice(2),
          strict: true,
          allowPositionals: false,
          options: {
            provider: { type: "string" },
            id: { type: "string" },
            "idle-timeout": { type: "string" },
            json: { type: "boolean" },
          },
        });
        expect(values).toEqual({
          provider: "proxmox",
          id: LEASE_ID,
          "idle-timeout": "60m",
          json: true,
        });
        renewed.push(values.id!);
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "inspect" && mode === "unavailable") {
        return commandResult({ code: 2, stderr: "transport unavailable" });
      }
      return readyResult(argv, {
        ...TAILNET_INSPECT,
        ...(mode === "drift" ? drift : {}),
      });
    });
    const lease = lifecycleLease(LEASE_ID, TAILNET_PROFILE);
    await expect(provider.inspect(lease)).resolves.toEqual(active);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewed).toEqual([LEASE_ID]);
    mode = "unavailable";
    await expect(provider.inspect(lease)).rejects.toThrow("transport unavailable");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewed).toEqual([LEASE_ID, LEASE_ID]);
    mode = "drift";
    await expect(provider.inspect(lease)).resolves.toEqual({ status: "unknown" });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls.filter((argv) => argv[1] === "heartbeat")).toHaveLength(2);
    expect(renewed).toEqual([LEASE_ID, LEASE_ID]);
    await provider.destroy(lease);
    expect(calls.at(-1)?.slice(1)).toEqual(["stop", "--provider", "proxmox", "--id", LEASE_ID]);
  },
);

it("offers only Linux OS and machines for private profiles without narrowing the shared public catalog", async () => {
  const provider = providerWithRunner(async () =>
    commandResult({
      stdout: catalogJson(
        "proxmox",
        ["linux", "windows/wsl2", "windows/normal"],
        [
          classProfile("standard", { vcpu: 8 }),
          classProfile("standard", { vcpu: 4 }, { target: "windows", windowsMode: "wsl2" }),
          classProfile("standard", { vcpu: 16 }, { target: "windows", windowsMode: "normal" }),
        ],
      ),
    }),
  );
  const publicProfile = { ...TAILNET_PROFILE, network: "public" };
  expect(await provider.listOperatingSystems?.(publicProfile)).toHaveLength(3);
  expect(await provider.listMachineOptions?.(publicProfile)).toHaveLength(3);
  expect(await provider.listOperatingSystems?.(TAILNET_PROFILE)).toEqual([
    { id: "linux", label: "Linux", default: true },
  ]);
  expect(await provider.listMachineOptions?.(TAILNET_PROFILE)).toEqual([
    { id: "standard", label: "Standard", os: "linux", cpu: 8, default: true },
  ]);
  expect(await provider.listOperatingSystems?.(publicProfile)).toHaveLength(3);
  expect(await provider.listMachineOptions?.(publicProfile)).toHaveLength(3);
});
