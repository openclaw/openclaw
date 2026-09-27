import path from "node:path";
import { fileURLToPath } from "node:url";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

vi.mock("./crabbox-managed-binary.js", () => ({
  ensureManagedCrabboxBinary: vi.fn(async ({ binary }: { binary: string }) => ({
    binary,
    version: "0.66.0",
  })),
}));

const LEASE_ID = "cbx_6071fc2062a6";
const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
const providers = new Set<ReturnType<typeof createCrabboxWorkerProvider>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...providers].map((provider) => provider.dispose()));
    } finally {
      providers.clear();
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      vi.unstubAllEnvs();
      cleanup();
    }
  }),
);
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-stop-")));

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}
function lifecycleLease() {
  return {
    leaseId: LEASE_ID,
    profile: {
      provider: "aws",
      ttl: "24h",
      idleTimeout: "60m",
      class: "standard",
      warmImage: false,
    },
  };
}
function providerWithRunner(
  runCommand: NonNullable<Parameters<typeof createCrabboxWorkerProvider>[0]["runCommand"]>,
) {
  const provider = createCrabboxWorkerProvider({
    state: crabboxState,
    runCommand,
    openclawRoot: OPENCLAW_ROOT,
    pathEnv: "",
    isExecutable: (candidate) => candidate === SIBLING_BINARY,
    wallpaperPath: fileURLToPath(
      new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
    ),
  });
  providers.add(provider);
  return provider;
}

describe("Crabbox worker stop confirmation", () => {
  it.each([
    {
      code: 5,
      stderr: `warning: could not inspect lease before release: coordinator GET http://127.0.0.1/v1/leases/${LEASE_ID}: http 404: not_found\ncoordinator accepted release for ${LEASE_ID}, but remote cleanup reported a cleanup failure or scheduled retry`,
    },
    { code: 4, stderr: `lease/server not found: ${LEASE_ID}` },
    { code: 4, stderr: `sandbox ${LEASE_ID} is not claimed by Crabbox` },
    { code: 4, stderr: `wandb sandbox "${LEASE_ID}" has no matching local ownership claim` },
    { code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` },
    ...["stopped", "released", "destroyed", "terminated"].map((state) => ({
      code: 4,
      stderr: `lease ${LEASE_ID} already ${state}`,
    })),
  ])("rejects unproven stop despite misleading prose: $stderr", async ({ code, stderr }) => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({ code, stderr });
    });
    await expect(provider.destroy(lifecycleLease())).rejects.toThrow(
      `stop failed with exit code ${code}`,
    );
    expect(calls).toEqual([[SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]]);
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
    const provider = providerWithRunner(runCommand);
    await expect(provider.destroy(lifecycleLease())).rejects.toThrow(
      "stop failed with exit code 1",
    );
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("accepts producer-confirmed absence only after a normal successful stop", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult();
    });
    await expect(provider.destroy(lifecycleLease())).resolves.toBeUndefined();
    await expect(provider.destroy(lifecycleLease())).resolves.toBeUndefined();
    expect(calls).toEqual([
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
      [SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
  });
});
