import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, vi } from "vitest";
import * as managedBinary from "./crabbox-managed-binary.js";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import type { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import {
  destroyAndWait,
  commandResult,
  createProviderFixtures,
  nodeEnrollmentFixture,
} from "./crabbox-worker-provider.test-support.js";

export { managedBinary };

export const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
export const LEASE_ID = operationLeaseId(OPERATION_ID);
export const CHECKPOINT_ID = "chk_profile_warm";
export const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
export const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: true };
export const NODE_RUNTIME_IDENTITY = {
  nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
  executionMode: "worker-turn" as const,
};

export function unsupportedCaptureReceipt(leaseId: string, provider = "aws") {
  return {
    schema: "crabbox.checkpoint.create.failure.v1",
    outcome: "not_submitted",
    reason: "native_unsupported",
    provider,
    leaseId,
    localReservation: "none",
    message:
      "checkpoint create --mode native is unsupported for provider=aws target=linux through coordinator https://coordinator.example: the provider does not offer native checkpoints for coordinator-brokered leases with this mode and strategy; use --mode archive or a provider configuration that offers native checkpoints",
  };
}

export const tempDirs: ReturnType<typeof useAutoCleanupTempDirTracker> =
  useAutoCleanupTempDirTracker(afterEach);
const { providers, createProvider } = createProviderFixtures({ sleep: async () => {} });
afterEach(async () => {
  await Promise.all([...providers].map((provider) => provider.dispose()));
  providers.clear();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

type CommandRunner = NonNullable<Parameters<typeof createCrabboxWorkerProvider>[0]["runCommand"]>;
export type CommandCall = { argv: string[]; options: Parameters<CommandRunner>[1] };

export function checkpointResult(
  checkpointId: string,
  leaseId: string,
  nativeState: "available" | "completed",
): SpawnResult {
  return commandResult({
    stdout: JSON.stringify({
      id: checkpointId,
      kind: "aws-ebs-snapshot",
      leaseId,
      workdir: "/workspace",
      native: { imageId: "snap_test", state: nativeState },
    }),
  });
}

export function createWarmProvider(
  command?: (call: CommandCall) => SpawnResult | Promise<SpawnResult | undefined> | undefined,
  stateDir = tempDirs.make("openclaw-crabbox-warm-image-"),
  dependencies: Pick<
    Parameters<typeof createCrabboxWorkerProvider>[0],
    "sleep" | "warmImagePolicy"
  > = {},
) {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockImplementation(async (params) => ({
    binary: params?.binary ?? "crabbox",
    version: "999.0.0",
  }));
  const calls: CommandCall[] = [];
  const warn = vi.fn();
  const provider = createProvider({
    warn,
    ...dependencies,
    runCommand: async (argv, options) => {
      const call = { argv, options };
      calls.push(call);
      const override = await command?.(call);
      if (override) {
        return override;
      }
      if (argv[1] === "config") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({
          stdout: JSON.stringify({
            id: argv[argv.indexOf("--id") + 1],
            state: "running",
            ready: true,
            providerMetadata: { instanceProfileAttached: false },
          }),
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "create") {
        return checkpointResult(CHECKPOINT_ID, argv[argv.indexOf("--id") + 1]!, "completed");
      }
      if (argv[1] === "checkpoint" && argv[2] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            localState: "metadata_available",
            providerState: "available",
            nextAction: "fork_or_delete",
          }),
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "fork") {
        return commandResult({
          stdout: JSON.stringify({
            checkpointId: argv[3],
            leaseId: argv[argv.indexOf("--lease-id") + 1],
            slug: argv[argv.indexOf("--slug") + 1],
            provider: argv[argv.indexOf("--provider") + 1],
            workdir: "/workspace",
          }),
        });
      }
      return commandResult();
    },
  });
  return { provider, calls, stateDir, warn };
}

export async function provisionWarmProfile(
  provider: WorkerProvider,
  profile: WorkerProfile = PROFILE,
  operationId = OPERATION_ID,
  machineClass?: string,
  options?: NonNullable<Parameters<WorkerProvider["provision"]>[2]>,
) {
  return provider.provision(profile, operationId, {
    assertCurrent: () => {},
    nodeRuntimeIdentity: NODE_RUNTIME_IDENTITY,
    ...options,
    ...(machineClass ? { machineClass } : {}),
    beginNodeEnrollment:
      options?.beginNodeEnrollment ??
      (async () => nodeEnrollmentFixture("setup-code", "Warm cloud worker")),
  });
}

export async function captureWarmImage(
  provider: WorkerProvider,
  profile: WorkerProfile = PROFILE,
  operationId = OPERATION_ID,
  machineClass?: string,
) {
  const lease = await provisionWarmProfile(provider, profile, operationId, machineClass);
  await destroyAndWait(provider, { leaseId: lease.leaseId, profile });
}

export const PROJECT_KEY = "a".repeat(64);
export const BASE_COMMIT = "b".repeat(40);
type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;

export function createProjectOptions(
  events: string[],
  controller = new AbortController(),
  preparation?: NonNullable<NonNullable<ProvisionOptions["project"]>["preparation"]>,
) {
  let enrollmentStarted = false;
  const observe = ({ argv }: CommandCall) => {
    if (argv[1] === "run" && argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
      events.push(enrollmentStarted ? "enrollment-install" : "runtime-install");
    }
    if (argv[1] === "checkpoint" && argv[2] === "create") {
      events.push("capture");
    }
    return undefined;
  };
  const options = {
    assertCurrent: () => controller.signal.throwIfAborted(),
    nodeRuntimeIdentity: {
      nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
      executionMode: "worker-turn" as const,
      workerBundleSha256: createWorkerArchiveFixture().sha256,
    },
    project: {
      key: PROJECT_KEY,
      baseCommit: BASE_COMMIT,
      ...(preparation ? { preparation } : {}),
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      prepare: vi.fn<NonNullable<ProvisionOptions["project"]>["prepare"]>(async (transport) => {
        await transport.runScript("project-checkout", controller.signal);
        events.push("project-prepared");
        return { seedKey: PROJECT_KEY, cacheHit: false };
      }),
    },
    prepareNodeRuntime: vi.fn(async () => {
      events.push("runtime-granted");
      return {
        nodeBootstrap: createNodeBootstrapFixture(),
        workerBundle: createWorkerArchiveFixture(),
        signal: controller.signal,
      };
    }),
    beginNodeEnrollment: vi.fn(async () => {
      events.push("enrollment-begun");
      enrollmentStarted = true;
      return {
        mode: "connect" as const,
        setupCode: "synthetic-setup-code",
        setupId: "project-setup",
        openclawVersion: "2026.8.1",
        nodeBootstrap: createNodeBootstrapFixture(),
        displayName: "Project worker",
        signal: controller.signal,
        waitForDeviceId: async () => "project-node",
      };
    }),
  } satisfies ProvisionOptions;
  return { options, observe };
}
