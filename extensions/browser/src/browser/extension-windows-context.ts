import crypto from "node:crypto";
import path from "node:path";
import {
  bindingSchema,
  receiptSchema,
  windowsManifestSchema,
  installationSchema,
  parseWindowsJson,
  sameWindowsPath,
  WINDOWS_NATIVE_EXE,
  WINDOWS_BINDING,
  WINDOWS_RECEIPT,
  WINDOWS_MANIFEST,
  type NativeWindowsContext,
  type WindowsInstallation,
} from "./extension-windows-contract.js";
import type { WindowsNativePlatform } from "./extension-windows-platform.js";
const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
export function matchesWindowsContext(a: NativeWindowsContext, b: NativeWindowsContext): boolean {
  return (
    a.browserProfile === b.browserProfile &&
    ["nodePath", "cliPath", "stateDir", "configPath"].every((key) => {
      // The property set is fixed by the strict context schema.
      switch (key) {
        case "nodePath":
          return sameWindowsPath(a.nodePath, b.nodePath);
        case "cliPath":
          return sameWindowsPath(a.cliPath, b.cliPath);
        case "stateDir":
          return sameWindowsPath(a.stateDir, b.stateDir);
        default:
          return sameWindowsPath(a.configPath, b.configPath);
      }
    })
  );
}
/** Descriptor/receipt are evidence, never permission to skip current OS admission. */
export async function readWindowsNativeGeneration(
  manifestPath: string,
  ops: WindowsNativePlatform,
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
    receipt.bindingSha256 !== hash(bindingBytes) ||
    receipt.manifestSha256 !== hash(manifestBytes) ||
    receipt.executableSha256 !== hash(image) ||
    binding.manifestPath !== installation.manifestPath ||
    manifest.path !== installation.launcherPath ||
    JSON.stringify(binding.expectedOrigins) !== JSON.stringify(manifest.allowed_origins)
  ) {
    throw new Error("Windows generation integrity mismatch");
  }
  return { installation, binding };
}
export async function admitWindowsNativeRuntime(
  params: { manifestPath: string; launcherPath: string; expectedOrigins: string[] },
  context: NativeWindowsContext,
  ops: WindowsNativePlatform,
): Promise<string> {
  const owned = await readWindowsNativeGeneration(params.manifestPath, ops);
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
