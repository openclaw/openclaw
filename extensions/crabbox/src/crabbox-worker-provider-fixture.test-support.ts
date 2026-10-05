import path from "node:path";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import {
  commandResult,
  createProviderFixtures,
  nodeEnrollmentFixture,
  OPENCLAW_ROOT,
} from "./crabbox-worker-provider.test-support.js";

export const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
export const LEASE_ID = "cbx_6071fc2062a6";
export const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");

export const INSPECT_FAILURE_PREFIX = "Crabbox inspect failed with exit code 2: ";
export const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
export const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: false };
export const NON_RUNNABLE_STATES = [
  "archived",
  "deleted",
  "deleting",
  "destroyed",
  "expired",
  "failed",
  "missing",
  "released",
  "stopped",
  "stopped_with_code",
  "terminated",
];
const { providers, createProvider } = createProviderFixtures({
  isExecutable: (candidate) => candidate === SIBLING_BINARY,
});
export const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
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
beforeEach(() => {
  vi.mocked(ensureManagedCrabboxBinary)
    .mockReset()
    .mockImplementation(async (params) => ({
      binary: params?.binary ?? "crabbox",
      version: "999.0.0",
    }));
  // Provider instances share durable state within a replay test, never across test cases.
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-provider-"));
});

export function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    sshUser: "openclaw",
    ready: true,
    ...overrides,
  });
}

export function lifecycleLease(leaseId = LEASE_ID, profile: WorkerProfile = PROFILE) {
  return { leaseId, profile };
}

export function providerWithRawRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep: (milliseconds: number) => Promise<void> = async () => {},
): WorkerProvider {
  const provider = createProvider({
    runCommand,
    sleep,
    ...(warn ? { warn } : {}),
  });
  return {
    ...provider,
    provision: (profile, operationId, options) =>
      provider.provision(profile, operationId, {
        assertCurrent: () => {},
        nodeRuntimeIdentity: {
          nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
          executionMode: options?.executionMode ?? "worker-turn",
        },
        ...options,
        beginNodeEnrollment:
          options?.beginNodeEnrollment ??
          (async () => nodeEnrollmentFixture("secret-setup-value", "Cloud worker test")),
      }),
  };
}

export function providerWithRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep?: (milliseconds: number) => Promise<void>,
) {
  return providerWithRawRunner(
    async (argv, options) => {
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return runCommand(argv, options);
    },
    warn,
    sleep,
  );
}

export function failedNodeEnrollment(
  error: Error,
): NonNullable<Parameters<WorkerProvider["provision"]>[2]> {
  return {
    beginNodeEnrollment: async () =>
      nodeEnrollmentFixture("secret-setup-value", "Cloud worker test", async () => {
        throw error;
      }),
  };
}

export function heartbeatFixture(run: CrabboxCommandRunner) {
  vi.useFakeTimers();
  const heartbeat = vi.fn(run);
  const warnings: string[] = [];
  const provider = providerWithRunner(
    async (argv, options) => {
      if (argv[1] === "heartbeat") {
        return heartbeat(argv, options);
      }
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    },
    (message) => warnings.push(message),
  );
  return { provider, heartbeat, warnings };
}
