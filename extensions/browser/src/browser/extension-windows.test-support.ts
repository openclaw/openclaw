import crypto from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import {
  BROWSER_NATIVE_HOST_DESCRIPTION,
  BROWSER_NATIVE_HOST_NAME,
} from "./extension-native-host.constants.js";
import * as win from "./extension-windows-contract.js";
import type { windowsNativePlatform } from "./extension-windows-platform.js";
export function windowsFixture() {
  const context: win.NativeWindowsContext = {
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
    "OpenClawTray/browser-native/generations",
    generation,
  );
  const installed = (name: string) => path.win32.join(dir, name);
  const installation = {
    generation,
    manifestPath: installed(win.WINDOWS_MANIFEST),
    launcherPath: installed(win.WINDOWS_NATIVE_EXE),
    bindingPath: installed(win.WINDOWS_BINDING),
    receiptPath: installed(win.WINDOWS_RECEIPT),
  };
  const executable = "C:\\OpenClaw\\" + win.WINDOWS_NATIVE_EXE;
  const files = new Map<string, Buffer>();
  const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  function prepare(
    selected = context,
    expectedOrigins = [win.WINDOWS_OFFICIAL_ORIGIN],
    companion = false,
  ) {
    const image = Buffer.from("MZ synthetic owned image; not Windows execution proof");
    const binding = json({
      version: 1,
      mode: companion ? "companion-managed-wsl" : "native-windows-cli",
      manifestPath: installation.manifestPath,
      expectedOrigins,
      nativeWindows: companion ? null : selected,
    });
    const manifest = json({
      name: BROWSER_NATIVE_HOST_NAME,
      description: BROWSER_NATIVE_HOST_DESCRIPTION,
      path: installation.launcherPath,
      type: "stdio",
      allowed_origins: expectedOrigins,
    });
    files.set(executable, image);
    files.set(installation.launcherPath, image);
    files.set(installation.bindingPath, binding);
    files.set(installation.manifestPath, manifest);
    files.set(
      installation.receiptPath,
      json({
        owner: "openclaw-browser-native-host",
        version: 1,
        generation,
        ownerSid: identity.sid,
        transportVerified: true,
        executableSha256: hash(image),
        bindingSha256: hash(binding),
        manifestSha256: hash(manifest),
      }),
    );
  }
  prepare();
  const ops = {
    identity: vi.fn(async () => identity),
    assertPath: vi.fn<typeof windowsNativePlatform.assertPath>(async () => {}),
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
      win.WINDOWS_NATIVE_EXE,
      win.WINDOWS_BINDING,
      win.WINDOWS_RECEIPT,
      win.WINDOWS_MANIFEST,
    ]),
    realpath: vi.fn(async (p) => p),
  } satisfies typeof windowsNativePlatform;
  const request: win.WindowsManagementRequest = {
    v: 1,
    action: "inspect",
    mode: "native-windows-cli",
    context,
    expectedOrigins: [win.WINDOWS_OFFICIAL_ORIGIN],
    store: "preserve",
  };
  const response: win.WindowsManagementResponse = {
    v: 1,
    ok: true,
    code: "ok",
    registration: "owned",
    mode: "native-windows-cli",
    store: "missing",
    installation,
  };
  return { context, identity, installation, executable, files, prepare, ops, request, response };
}
