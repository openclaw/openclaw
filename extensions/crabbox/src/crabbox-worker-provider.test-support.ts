import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { vi } from "vitest";
import * as binaryDiscovery from "./crabbox-binary.js";
import * as processRunner from "./crabbox-process.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";

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
export function createProviderFixtures(defaults: ProviderFixtureDependencies = {}) {
  const providers = new Set<ReturnType<typeof createCrabboxWorkerProvider>>();
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
      const provider = createCrabboxWorkerProvider({
        state: crabboxState,
        openclawRoot: OPENCLAW_ROOT,
        wallpaperPath: WORKER_WALLPAPER_PATH,
        ...options,
        warn: dependencies.warn ?? defaults.warn,
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
