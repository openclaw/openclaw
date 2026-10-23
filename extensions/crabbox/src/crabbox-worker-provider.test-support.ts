import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, vi } from "vitest";
import * as binaryDiscovery from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import * as processRunner from "./crabbox-process.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import * as warmImage from "./crabbox-worker-warm-image.js";

export const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
export const WORKER_WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
type ProviderDependencies = Parameters<typeof createCrabboxWorkerProvider>[0];
export type ProviderFixtureDependencies = Partial<ProviderDependencies> & {
  runCommand?: CrabboxCommandRunner;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  isExecutable?: (candidate: string) => boolean;
};
type Provider = ReturnType<typeof createCrabboxWorkerProvider>;
type Teardown = ReturnType<typeof Promise.withResolvers<void>>;
const teardowns = new WeakMap<WorkerProvider["destroy"], Map<string, Teardown>>();
const createWarmImageManager = warmImage.createCrabboxWarmImageManager;

export async function waitForTeardown(provider: WorkerProvider, leaseId: string): Promise<void> {
  await teardowns.get(provider.destroy)?.get(leaseId)?.promise;
}

export async function destroyAndWait(
  provider: WorkerProvider,
  lease: Parameters<Provider["destroy"]>[0],
): Promise<void> {
  await provider.destroy(lease);
  await waitForTeardown(provider, lease.leaseId);
}

export function createProviderFixtures(defaults: ProviderFixtureDependencies = {}) {
  const providers = new Set<Provider>();
  return {
    providers,
    createProvider: (dependencies: ProviderFixtureDependencies) => {
      const { runCommand, sleep, isExecutable, ...options } = { ...defaults, ...dependencies };
      if (runCommand) {
        vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(runCommand);
      }
      if (sleep) {
        vi.spyOn(timers, "setTimeout").mockImplementation(
          async (milliseconds, value, timerOptions) => {
            await sleep(milliseconds ?? 1, timerOptions?.signal);
            return value;
          },
        );
        syncBuiltinESMExports();
      }
      const sibling = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");
      vi.spyOn(binaryDiscovery, "resolveCrabboxBinary").mockReturnValue(
        isExecutable?.(sibling) ? sibling : "crabbox",
      );
      const pending = new Map<string, Teardown>();
      // Observe real cleanup completion without making destroy synchronous in tests.
      vi.spyOn(warmImage, "createCrabboxWarmImageManager").mockImplementationOnce(
        (managerOptions) => {
          const manager = createWarmImageManager(managerOptions);
          const release = manager.release.bind(manager);
          manager.release = async (context) => {
            await release(context);
            pending.get(context.id)?.resolve();
          };
          return manager;
        },
      );
      const provider = createCrabboxWorkerProvider({
        state: crabboxState,
        openclawRoot: OPENCLAW_ROOT,
        wallpaperPath: WORKER_WALLPAPER_PATH,
        ...options,
        warn: (message) => {
          (dependencies.warn ?? defaults.warn)?.(message);
          for (const [id, completion] of pending) {
            if (message.startsWith(`Crabbox teardown stop failed for lease ${id}:`)) {
              completion.reject(new Error(message));
            }
          }
        },
      });
      const destroy = provider.destroy.bind(provider);
      provider.destroy = (lease) => {
        const completion = Promise.withResolvers<void>();
        void completion.promise.catch(() => {});
        pending.set(lease.leaseId, completion);
        return destroy(lease).catch((error: unknown) => {
          completion.reject(error);
          throw error;
        });
      };
      teardowns.set(provider.destroy, pending);
      providers.add(provider);
      return provider;
    },
  };
}

export function createProviderTestHarness(
  defaults: ProviderFixtureDependencies = {},
  statePrefix?: string,
) {
  const fixtures = createProviderFixtures(defaults);
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        await Promise.all([...fixtures.providers].map((provider) => provider.dispose()));
      } finally {
        fixtures.providers.clear();
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (statePrefix) {
          await closeOpenClawStateDatabaseAsync();
          resetPluginStateStoreForTests();
        }
        vi.unstubAllEnvs();
        syncBuiltinESMExports();
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
    if (statePrefix) {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make(statePrefix));
    }
  });
  return { ...fixtures, tempDirs };
}

export function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
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

export function nodeEnrollmentFixture(
  setupCode: string,
  displayName: string,
  waitForDeviceId = async () => "device-1",
) {
  return {
    mode: "connect" as const,
    setupCode,
    setupId: "setup-id",
    openclawVersion: "2026.8.1",
    nodeBootstrap: createNodeBootstrapFixture(),
    displayName,
    waitForDeviceId,
  };
}

export const active = { status: "active", sharedHost: false };

export function classProfile(
  machineClass: string,
  primary: Record<string, unknown> = {},
  selectors: Record<string, unknown> = {},
) {
  return {
    class: machineClass,
    target: "linux",
    architecture: "amd64",
    primary: {
      type: "native-8vcpu-16gb",
      ...primary,
    },
    ...selectors,
  };
}

export function mappedCatalog(profiles: unknown[]) {
  return { disposition: "mapped", profiles };
}

export function catalogJson(
  provider: string,
  targets: string[],
  profiles: unknown[],
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify([{ provider, targets, classCatalog: mappedCatalog(profiles), ...extra }]);
}
