import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { crabboxState } from "./crabbox-state.test-support.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

export const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
export const WORKER_WALLPAPER_PATH = fileURLToPath(
  new URL("../assets/openclaw-worker-wallpaper.png", import.meta.url),
);
type ProviderDependencies = Parameters<typeof createCrabboxWorkerProvider>[0];

export function createProviderFixtures(defaults: Partial<ProviderDependencies> = {}) {
  const providers = new Set<ReturnType<typeof createCrabboxWorkerProvider>>();
  return {
    providers,
    createProvider: (dependencies: Partial<ProviderDependencies>) => {
      const provider = createCrabboxWorkerProvider({
        state: crabboxState,
        openclawRoot: OPENCLAW_ROOT,
        pathEnv: "",
        isExecutable: () => false,
        wallpaperPath: WORKER_WALLPAPER_PATH,
        ...defaults,
        ...dependencies,
      });
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
