import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { ChromeProduct, ExtensionInstallDeps } from "./extension-install-layout.js";

export type NativeHostLaunchContext = { stateDir: string; configPath?: string };

export type NativeHostRegistrationStatus = {
  product: ChromeProduct;
  browser: string;
  manifestPath: string;
  extensionIds: string[];
  state: "missing" | "owned" | "foreign" | "invalid" | null;
  issue?: string;
  browserProfile?: string;
  nativeHostPath?: string;
  launcherPath?: string;
  launchContext?: NativeHostLaunchContext;
};

export function resolveInstallStateDir(deps: ExtensionInstallDeps): string {
  return path.resolve(deps.stateDir ?? resolveStateDir(deps.env));
}

export function resolveInstallConfigPath(deps: ExtensionInstallDeps): string | undefined {
  const env = deps.env ?? process.env;
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  return explicit ? resolveStateDir({ ...env, OPENCLAW_STATE_DIR: explicit }) : undefined;
}

export class NativeHostSetupContextError extends Error {}

export function assertExpectedNativeHostProfile(
  registration: NativeHostRegistrationStatus,
  expectedRegistrations?: readonly NativeHostRegistrationStatus[],
): void {
  if (!expectedRegistrations) {
    return;
  }
  const expected = expectedRegistrations.find(
    (entry) => entry.manifestPath === registration.manifestPath,
  );
  if (
    !expected ||
    registration.state !== expected.state ||
    registration.browserProfile !== expected.browserProfile
  ) {
    throw new NativeHostSetupContextError(
      "Chrome's native host browser selection changed during setup. Inspect setup again before retrying.",
    );
  }
}

export function assertCurrentNativeHostLaunchContext(
  registration: NativeHostRegistrationStatus,
  deps: ExtensionInstallDeps,
): void {
  if (registration.state !== "owned") {
    return;
  }
  const saved = registration.launchContext;
  const current = {
    stateDir: resolveInstallStateDir(deps),
    configPath: resolveInstallConfigPath(deps),
  };
  const configPath = (context: NativeHostLaunchContext) =>
    resolveConfigPath(
      {
        ...(deps.env ?? process.env),
        OPENCLAW_STATE_DIR: context.stateDir,
        OPENCLAW_CONFIG_PATH: context.configPath,
      },
      context.stateDir,
    );
  if (
    !saved ||
    path.resolve(saved.stateDir) !== current.stateDir ||
    configPath(saved) !== configPath(current)
  ) {
    throw new NativeHostSetupContextError(
      "Chrome's native host uses a different OpenClaw configuration. Rerun setup with its matching OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH.",
    );
  }
}
