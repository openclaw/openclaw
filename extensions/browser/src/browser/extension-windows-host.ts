import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { ChromeStoreInstallRequest } from "./extension-install-external.js";
import type { ChromeProduct, ExtensionInstallDeps } from "./extension-install-layout.js";
import {
  admitWindowsNativeRuntime,
  readWindowsNativeGeneration,
  matchesWindowsContext,
} from "./extension-windows-context.js";
import {
  nativeWindowsContextSchema,
  managementRequestSchema,
  originsSchema,
  WINDOWS_NATIVE_EXE,
  WINDOWS_OFFICIAL_ORIGIN,
  type NativeWindowsContext,
  type WindowsManagementRequest,
  type WindowsManagementResponse,
} from "./extension-windows-contract.js";
import {
  runWindowsManagement,
  WindowsManagementTransportError,
} from "./extension-windows-management.js";
import { createWindowsNativePlatform } from "./extension-windows-platform.js";

const products: Array<[ChromeProduct, string]> = [
  ["chrome", "Google Chrome"],
  ["chromium", "Chromium"],
  ["chrome-for-testing", "Google Chrome for Testing"],
];
const operations = (deps: ExtensionInstallDeps) =>
  deps.windowsNative?.platform ?? createWindowsNativePlatform(deps.env);
async function resolveCliPath(pluginRoot?: string): Promise<string> {
  if (!pluginRoot) {
    return await fs.realpath(process.argv[1]!);
  }
  for (let cursor = path.resolve(pluginRoot); ;) {
    const candidate = path.join(cursor, "openclaw.mjs");
    try {
      return await fs.realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error("Local Windows CLI unavailable");
    }
    cursor = parent;
  }
}
async function selectedContext(
  deps: ExtensionInstallDeps,
  profile: string,
  pluginRoot?: string,
): Promise<NativeWindowsContext> {
  if (deps.windowsNative?.context) {
    return nativeWindowsContextSchema.parse({
      ...deps.windowsNative.context,
      browserProfile: profile,
    });
  }
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? resolveStateDir(env);
  return nativeWindowsContextSchema.parse({
    nodePath: await operations(deps).realpath(deps.nodePath ?? process.execPath),
    cliPath: await operations(deps).realpath(
      deps.windowsNative?.cliPath ?? (await resolveCliPath(pluginRoot)),
    ),
    stateDir,
    configPath: resolveConfigPath(env, stateDir),
    browserProfile: profile,
  });
}
async function executableFor(
  pluginRoot: string | undefined,
  explicit: string | undefined,
  deps: ExtensionInstallDeps,
): Promise<string> {
  const ops = operations(deps);
  const identity = await ops.identity();
  const candidates = explicit
    ? [explicit]
    : [
        ...(pluginRoot
          ? [
              path.win32.join(
                pluginRoot,
                "native-host",
                "win32-" + process.arch,
                WINDOWS_NATIVE_EXE,
              ),
            ]
          : []),
        path.win32.join(
          identity.localAppData,
          "OpenClawTray",
          "tools",
          "browser-bootstrap",
          WINDOWS_NATIVE_EXE,
        ),
      ];
  for (const candidate of candidates) {
    try {
      // Bind readable image admission to a descriptor as well as ancestry checks.
      const canonical = await ops.realpath(candidate);
      await ops.readFile(canonical, 256 * 1024 * 1024, false);
      return canonical;
    } catch (error) {
      if (explicit || !(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new WindowsManagementTransportError(false);
}
export type WindowsHostProjection = {
  registrations: Array<{
    product: ChromeProduct;
    browser: string;
    manifestPath: string;
    extensionIds: string[];
    state: WindowsManagementResponse["registration"];
    issue?: string;
    browserProfile?: string;
  }>;
  storeInstallRequests: ChromeStoreInstallRequest[];
  issues: string[];
};
// Invocation-local facts stay off the serialized status surface. The controller
// consumes the C# observation, not diagnostic strings or inferred ownership.
const managementObservations = new WeakMap<
  object,
  {
    response: WindowsManagementResponse | null;
    browserProfile?: string;
  }
>();
export function windowsManagementObservation(registrations: object) {
  return managementObservations.get(registrations);
}
function projection(
  response: WindowsManagementResponse | null,
  origins: string[],
  issue?: string,
  browserProfile?: string,
): WindowsHostProjection {
  const nativeIssue =
    issue ??
    (!response?.ok &&
    response?.code !== "browser_control_disabled" &&
    !(
      response?.registration === "owned" &&
      response.code === "foreign_registration" &&
      response.store === "foreign"
    )
      ? "Windows management reported " + (response?.code ?? "an unknown outcome")
      : undefined);
  const result: WindowsHostProjection = {
    registrations: products.map(([product, browser]) => ({
      product,
      browser,
      manifestPath: "Windows current-user native registration",
      state: response?.registration ?? null,
      extensionIds: response?.installation ? origins.map((o) => o.slice(19, -1)) : [],
      issue: nativeIssue,
      browserProfile,
    })),
    storeInstallRequests: [
      {
        browser: "Google Chrome",
        path: "Windows current-user Chrome Store request",
        state: response?.store ?? null,
        ...(!response?.ok
          ? {
              issue:
                issue ?? "Windows management reported " + (response?.code ?? "an unknown outcome"),
            }
          : {}),
      },
    ],
    issues: issue
      ? [issue]
      : response && !response.ok
        ? ["Windows management reported " + response.code]
        : [],
  };
  managementObservations.set(result.registrations, { response, browserProfile });
  return result;
}
async function operate(params: {
  action: WindowsManagementRequest["action"];
  store: WindowsManagementRequest["store"];
  pluginRoot?: string;
  executable?: string;
  extensionIds?: string[];
  browserProfile?: string;
  deps: ExtensionInstallDeps;
  signal?: AbortSignal;
}): Promise<{ response: WindowsManagementResponse; origins: string[]; browserProfile?: string }> {
  let started = false;
  try {
    params.signal?.throwIfAborted();
    const deps = params.deps;
    const context = await selectedContext(
      deps,
      params.browserProfile ?? "chrome",
      params.pluginRoot,
    );
    const origins = originsSchema.parse(
      [
        ...new Set([
          WINDOWS_OFFICIAL_ORIGIN,
          ...(params.extensionIds ?? []).map((id) => "chrome-extension://" + id + "/"),
        ]),
      ].toSorted(),
    );
    const request = managementRequestSchema.parse({
      v: 1,
      mode: "native-windows-cli",
      context,
      action: params.action,
      store: params.store,
      expectedOrigins: origins,
    });
    const executable = await executableFor(
      params.pluginRoot,
      params.executable ?? deps.windowsNative?.executable,
      deps,
    );
    params.signal?.throwIfAborted();
    started = true;
    const response = await (deps.windowsNative?.manage ?? runWindowsManagement)(
      executable,
      request,
      {
        env: deps.env,
        signal: params.signal,
      },
    );
    params.signal?.throwIfAborted();
    let browserProfile: string | undefined;
    if (response.installation) {
      const owned = await readWindowsNativeGeneration(
        response.installation.manifestPath,
        operations(deps),
      );
      if (
        JSON.stringify(owned.installation) !== JSON.stringify(response.installation) ||
        owned.binding.mode !== "native-windows-cli" ||
        !owned.binding.nativeWindows ||
        !matchesWindowsContext(owned.binding.nativeWindows, context) ||
        JSON.stringify(owned.binding.expectedOrigins) !== JSON.stringify(origins)
      ) {
        throw new WindowsManagementTransportError(true);
      }
      browserProfile = owned.binding.nativeWindows.browserProfile;
    }
    params.signal?.throwIfAborted();
    return { response, origins, browserProfile };
  } catch (error) {
    if (error instanceof WindowsManagementTransportError) {
      throw error;
    }
    throw new WindowsManagementTransportError(started);
  }
}
export async function installWindowsNativeHost(params: {
  pluginRoot: string;
  executable?: string;
  extensionIds: string[];
  browserProfile?: string;
  requestStoreInstall?: boolean;
  deps: ExtensionInstallDeps;
  signal?: AbortSignal;
}): Promise<WindowsHostProjection> {
  // No discovery retry or mode fallback after a started mutation, even for an older helper.
  const { response, origins, browserProfile } = await operate({
    ...params,
    action: "install",
    store: params.requestStoreInstall === true ? "request" : "preserve",
  });
  return projection(response, origins, undefined, browserProfile);
}
export async function inspectWindowsNativeHosts(
  params: {
    deps?: ExtensionInstallDeps;
    pluginRoot?: string;
    executable?: string;
    extensionIds?: string[];
    browserProfile?: string;
    signal?: AbortSignal;
  } = {},
): Promise<WindowsHostProjection> {
  try {
    const { response, origins, browserProfile } = await operate({
      ...params,
      deps: params.deps ?? {},
      action: "inspect",
      store: "preserve",
    });
    return projection(response, origins, undefined, browserProfile);
  } catch {
    return projection(
      null,
      [],
      "Windows management observation is unavailable. Inspect the same local context with a compatible helper.",
    );
  }
}
export async function uninstallWindowsNativeHosts(
  params: {
    deps?: ExtensionInstallDeps;
    pluginRoot?: string;
    executable?: string;
    browserProfile?: string;
    removeStore?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const { response } = await operate({
    ...params,
    deps: params.deps ?? {},
    action: "uninstall",
    store: params.removeStore ? "remove" : "preserve",
  });
  return {
    removed: response.ok ? ["Windows current-user native registration"] : [],
    refused: response.ok ? [] : ["Windows management reported " + response.code],
    manualRequired: false,
  };
}
/** Used only by the native CLI, behind frame validation and before config or keys. */
export async function validateWindowsNativeContext(
  params: {
    manifestPath: string;
    launcherPath: string;
    expectedOrigins: string[];
    stateDir?: string;
  },
  deps: ExtensionInstallDeps = {},
): Promise<string> {
  const profileIndex = process.argv.indexOf("--browser-profile");
  const profile =
    deps.windowsNative?.context?.browserProfile ??
    (profileIndex < 0 ? "chrome" : process.argv[profileIndex + 1]);
  if (!profile) {
    throw new Error("Missing bound browser profile");
  }
  const context = await selectedContext(
    { ...deps, stateDir: params.stateDir ?? deps.stateDir },
    profile,
  );
  return await admitWindowsNativeRuntime(params, context, operations(deps));
}
