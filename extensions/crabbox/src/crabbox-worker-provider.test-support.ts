import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { vi } from "vitest";
import { crabboxState } from "./crabbox-state.test-support.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import * as warmImage from "./crabbox-worker-warm-image.js";

export const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
export const WORKER_WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
type ProviderDependencies = Parameters<typeof createCrabboxWorkerProvider>[0];
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

export function createProviderFixtures(defaults: Partial<ProviderDependencies> = {}) {
  const providers = new Set<ReturnType<typeof createCrabboxWorkerProvider>>();
  return {
    providers,
    createProvider: (dependencies: Partial<ProviderDependencies>) => {
      const pending = new Map<string, Teardown>();
      // Observe real cleanup completion without making destroy synchronous in tests.
      vi.spyOn(warmImage, "createCrabboxWarmImageManager").mockImplementationOnce((options) => {
        const manager = createWarmImageManager(options);
        const release = manager.release.bind(manager);
        manager.release = async (context) => {
          await release(context);
          pending.get(context.id)?.resolve();
        };
        return manager;
      });
      const provider = createCrabboxWorkerProvider({
        state: crabboxState,
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "",
        isExecutable: () => false,
        wallpaperPath: WORKER_WALLPAPER_PATH,
        ...defaults,
        ...dependencies,
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

export function inspectCases(nonRunnableStates: readonly string[]) {
  return [
    { state: "running", ready: true, expected: active },
    { state: "running", ready: false, expected: active },
    { state: "provisioning", ready: false, expected: active },
    ...nonRunnableStates.map((state) => ({ state, ready: false, expected: { status: "unknown" } })),
  ];
}

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
      architecture: "amd64",
      vcpu: null,
      memory: null,
      ...primary,
    },
    fallbacks: [],
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
