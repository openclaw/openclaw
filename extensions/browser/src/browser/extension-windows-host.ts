import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { resolveConfigPath, resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { NativeHostRegistrationStatus } from "./extension-install-context.js";
import type { ChromeStoreInstallRequest } from "./extension-install-external.js";
import type { ChromeProduct } from "./extension-install-layout.js";
import {
  bindingSchema,
  receiptSchema,
  windowsManifestSchema,
  installationSchema,
  parseWindowsJson,
  sameWindowsPath,
  nativeWindowsContextSchema,
  managementRequestSchema,
  WINDOWS_NATIVE_EXE,
  WINDOWS_BINDING,
  WINDOWS_RECEIPT,
  WINDOWS_MANIFEST,
  WINDOWS_OFFICIAL_ORIGIN,
  type NativeWindowsContext,
  type WindowsInstallation,
  type WindowsManagementRequest,
  type WindowsManagementResponse,
} from "./extension-windows-contract.js";
import {
  runWindowsManagement,
  WindowsManagementTransportError,
} from "./extension-windows-management.js";
import { windowsNativePlatform as ops } from "./extension-windows-platform.js";

function matchesWindowsContext(a: NativeWindowsContext, b: NativeWindowsContext): boolean {
  return (
    a.browserProfile === b.browserProfile &&
    (["nodePath", "cliPath", "stateDir", "configPath"] as const).every((key) =>
      sameWindowsPath(a[key], b[key]),
    )
  );
}
/** Descriptor/receipt are evidence, never permission to skip current OS admission. */
async function readWindowsNativeGeneration(
  manifestPath: string,
): Promise<{ installation: WindowsInstallation; binding: ReturnType<typeof bindingSchema.parse> }> {
  const identity = await ops.identity();
  const root = path.win32.join(
    identity.localAppData,
    "OpenClawTray",
    "browser-native",
    "generations",
  );
  const dir = path.win32.dirname(manifestPath);
  const installation = installationSchema.parse({
    generation: path.win32.basename(dir),
    manifestPath,
    launcherPath: path.win32.join(dir, WINDOWS_NATIVE_EXE),
    bindingPath: path.win32.join(dir, WINDOWS_BINDING),
    receiptPath: path.win32.join(dir, WINDOWS_RECEIPT),
  });
  if (!sameWindowsPath(path.win32.dirname(dir), root)) {
    throw new Error("Windows generation is outside the fixed root");
  }
  for (const directory of [root, dir]) {
    await ops.assertPath(directory, { kind: "directory", private: true });
  }
  const files = await ops.listFiles(dir);
  if (
    files.length !== 4 ||
    files.some(
      (name) =>
        ![WINDOWS_NATIVE_EXE, WINDOWS_BINDING, WINDOWS_RECEIPT, WINDOWS_MANIFEST].includes(name),
    )
  ) {
    throw new Error("Windows generation contains foreign files");
  }
  const [receiptBytes, bindingBytes, manifestBytes, image] = await Promise.all([
    ops.readFile(installation.receiptPath, 32768),
    ops.readFile(installation.bindingPath, 32768),
    ops.readFile(installation.manifestPath, 32768),
    ops.readFile(installation.launcherPath, 256 * 1024 * 1024),
  ]);
  const receipt = receiptSchema.parse(parseWindowsJson(receiptBytes));
  const binding = bindingSchema.parse(parseWindowsJson(bindingBytes));
  const manifest = windowsManifestSchema.parse(parseWindowsJson(manifestBytes));
  if (
    receipt.ownerSid !== identity.sid ||
    receipt.generation !== installation.generation ||
    receipt.bindingSha256 !== sha256Hex(bindingBytes) ||
    receipt.manifestSha256 !== sha256Hex(manifestBytes) ||
    receipt.executableSha256 !== sha256Hex(image) ||
    binding.manifestPath !== installation.manifestPath ||
    manifest.path !== installation.launcherPath ||
    JSON.stringify(binding.expectedOrigins) !== JSON.stringify(manifest.allowed_origins)
  ) {
    throw new Error("Windows generation integrity mismatch");
  }
  return { installation, binding };
}
async function admitWindowsNativeRuntime(
  params: { manifestPath: string; launcherPath: string; expectedOrigins: string[] },
  context: NativeWindowsContext,
): Promise<string> {
  const owned = await readWindowsNativeGeneration(params.manifestPath);
  if (
    owned.binding.mode !== "native-windows-cli" ||
    !owned.binding.nativeWindows ||
    !matchesWindowsContext(owned.binding.nativeWindows, context) ||
    !sameWindowsPath(owned.installation.launcherPath, params.launcherPath) ||
    JSON.stringify(owned.binding.expectedOrigins) !== JSON.stringify(params.expectedOrigins)
  ) {
    throw new Error("Windows native execution context mismatch");
  }
  await ops.assertPath(context.nodePath, { kind: "file", private: false });
  await ops.assertPath(context.cliPath, { kind: "file", private: false });
  await ops.assertPath(context.stateDir, { kind: "directory", private: true, allowMissing: true });
  await ops.assertPath(context.configPath, { kind: "file", private: true, allowMissing: true });
  return context.browserProfile;
}

const products: Array<[ChromeProduct, string]> = [
  ["chrome", "Google Chrome"],
  ["chromium", "Chromium"],
  ["chrome-for-testing", "Google Chrome for Testing"],
];
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
  profile: string,
  pluginRoot?: string,
  stateDirOverride?: string,
): Promise<NativeWindowsContext> {
  const env = process.env;
  const stateDir = stateDirOverride ?? resolveStateDir(env);
  return nativeWindowsContextSchema.parse({
    nodePath: await ops.realpath(process.execPath),
    cliPath: await ops.realpath(await resolveCliPath(pluginRoot)),
    stateDir,
    configPath: resolveConfigPath(env, stateDir),
    browserProfile: profile,
  });
}
async function executableFor(
  pluginRoot: string | undefined,
  explicit: string | undefined,
): Promise<string> {
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
  registrations: NativeHostRegistrationStatus[];
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
  const managementIssue =
    issue ?? "Windows management reported " + (response?.code ?? "an unknown outcome");
  const nativeIssue =
    issue ??
    (!response?.ok &&
    response?.code !== "browser_control_disabled" &&
    !(
      response?.registration === "owned" &&
      response.code === "foreign_registration" &&
      response.store === "foreign"
    )
      ? managementIssue
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
        ...(!response?.ok ? { issue: managementIssue } : {}),
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
  signal?: AbortSignal;
}): Promise<{ response: WindowsManagementResponse; origins: string[]; browserProfile?: string }> {
  let started = false;
  try {
    params.signal?.throwIfAborted();
    const context = await selectedContext(params.browserProfile ?? "chrome", params.pluginRoot);
    const origins = [
      ...new Set([
        WINDOWS_OFFICIAL_ORIGIN,
        ...(params.extensionIds ?? []).map((id) => "chrome-extension://" + id + "/"),
      ]),
    ].toSorted();
    const request = managementRequestSchema.parse({
      v: 1,
      mode: "native-windows-cli",
      context,
      action: params.action,
      store: params.store,
      expectedOrigins: origins,
    });
    const executable = await executableFor(params.pluginRoot, params.executable);
    params.signal?.throwIfAborted();
    started = true;
    const response = await runWindowsManagement(executable, request, {
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    let browserProfile: string | undefined;
    if (response.installation) {
      const owned = await readWindowsNativeGeneration(response.installation.manifestPath);
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
    pluginRoot?: string;
    executable?: string;
    browserProfile?: string;
    removeStore?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const { response } = await operate({
    ...params,
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
export async function validateWindowsNativeContext(params: {
  manifestPath: string;
  launcherPath: string;
  expectedOrigins: string[];
  stateDir?: string;
}): Promise<string> {
  const profileIndex = process.argv.indexOf("--browser-profile");
  const profile = profileIndex < 0 ? "chrome" : process.argv[profileIndex + 1];
  if (!profile) {
    throw new Error("Missing bound browser profile");
  }
  const context = await selectedContext(profile, undefined, params.stateDir);
  return await admitWindowsNativeRuntime(params, context);
}
