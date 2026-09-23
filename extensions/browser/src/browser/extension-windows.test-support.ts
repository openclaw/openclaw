import crypto from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import {
  BROWSER_NATIVE_HOST_DESCRIPTION,
  BROWSER_NATIVE_HOST_NAME,
} from "./extension-native-host.constants.js";
import {
  WINDOWS_NATIVE_EXE,
  WINDOWS_BINDING,
  WINDOWS_RECEIPT,
  WINDOWS_MANIFEST,
  WINDOWS_OFFICIAL_ORIGIN,
  type NativeWindowsContext,
  type WindowsManagementRequest,
  type WindowsManagementResponse,
} from "./extension-windows-contract.js";
import type { WindowsNativePlatform } from "./extension-windows-platform.js";
export function windowsFixture() {
  const context: NativeWindowsContext = {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    cliPath: "C:\\OpenClaw\\openclaw.mjs",
    stateDir: "C:\\Users\\Fixture\\.openclaw",
    configPath: "C:\\Users\\Fixture\\.openclaw\\openclaw.json",
    browserProfile: "chrome",
  };
  const identity = {
    localAppData: "C:\\Users\\Fixture\\AppData\\Local",
    sid: "S-1-5-21-111-222-333-1001",
  };
  const generation = "12345678-1234-4234-8234-123456789abc";
  const dir = path.win32.join(
    identity.localAppData,
    "OpenClawTray",
    "browser-native",
    "generations",
    generation,
  );
  const installation = {
    generation,
    manifestPath: path.win32.join(dir, WINDOWS_MANIFEST),
    launcherPath: path.win32.join(dir, WINDOWS_NATIVE_EXE),
    bindingPath: path.win32.join(dir, WINDOWS_BINDING),
    receiptPath: path.win32.join(dir, WINDOWS_RECEIPT),
  };
  const executable = "C:\\OpenClaw\\" + WINDOWS_NATIVE_EXE;
  const files = new Map<string, Buffer>();
  const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
  function prepare(
    selected = context,
    expectedOrigins = [WINDOWS_OFFICIAL_ORIGIN],
    companion = false,
  ) {
    const image = Buffer.from("MZ synthetic owned image; not Windows execution proof");
    const binding = Buffer.from(
      JSON.stringify({
        version: 1,
        mode: companion ? "companion-managed-wsl" : "native-windows-cli",
        manifestPath: installation.manifestPath,
        expectedOrigins,
        nativeWindows: companion ? null : selected,
      }),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        name: BROWSER_NATIVE_HOST_NAME,
        description: BROWSER_NATIVE_HOST_DESCRIPTION,
        path: installation.launcherPath,
        type: "stdio",
        allowed_origins: expectedOrigins,
      }),
    );
    files.set(executable, image);
    files.set(installation.launcherPath, image);
    files.set(installation.bindingPath, binding);
    files.set(installation.manifestPath, manifest);
    files.set(
      installation.receiptPath,
      Buffer.from(
        JSON.stringify({
          owner: "openclaw-browser-native-host",
          version: 1,
          generation,
          ownerSid: identity.sid,
          transportVerified: true,
          executableSha256: hash(image),
          bindingSha256: hash(binding),
          manifestSha256: hash(manifest),
        }),
      ),
    );
  }
  prepare();
  const ops: WindowsNativePlatform = {
    identity: vi.fn(async () => identity),
    assertPath: vi.fn(async () => {}),
    readFile: vi.fn(async (file, maxBytes) => {
      const bytes = files.get(file);
      if (!bytes) {
        throw Object.assign(new Error("fixture missing"), { code: "ENOENT" });
      }
      if (bytes.length > maxBytes) {
        throw new Error("fixture size limit");
      }
      return bytes;
    }),
    listFiles: vi.fn(async () => [
      WINDOWS_NATIVE_EXE,
      WINDOWS_BINDING,
      WINDOWS_RECEIPT,
      WINDOWS_MANIFEST,
    ]),
    realpath: vi.fn(async (p) => p),
  };
  const request: WindowsManagementRequest = {
    v: 1,
    action: "inspect",
    mode: "native-windows-cli",
    context,
    expectedOrigins: [WINDOWS_OFFICIAL_ORIGIN],
    store: "preserve",
  };
  const response: WindowsManagementResponse = {
    v: 1,
    ok: true,
    code: "ok",
    registration: "owned",
    mode: "native-windows-cli",
    store: "missing",
    installation,
  };
  return {
    context,
    identity,
    dir,
    installation,
    executable,
    files,
    prepare,
    ops,
    request,
    response,
  };
}
