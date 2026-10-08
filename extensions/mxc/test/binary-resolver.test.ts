import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildMxcNativeEnv, resolveMxcNativeBinaries } from "../src/binary-resolver.js";

const arch = process.arch === "arm64" ? "arm64" : "x64";
const otherArch = arch === "arm64" ? "x64" : "arm64";

describe("resolveMxcNativeBinaries", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mxc-native-"));
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  function writeRelease(archDir: string, files = ["wxc-exec.exe", "mxc_ffi.dll"]): string {
    const dir = path.join(root, archDir);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
      writeFileSync(path.join(dir, file), "");
    }
    return path.join(dir, "wxc-exec.exe");
  }

  test("pins both native components from a matching override layout", () => {
    const executorPath = writeRelease(arch);
    const binaries = resolveMxcNativeBinaries(executorPath);

    expect(binaries).toEqual({
      binDir: root,
      archDir: path.join(root, arch),
      executorPath,
      nativeLibraryPath: path.join(root, arch, "mxc_ffi.dll"),
    });
    expect(buildMxcNativeEnv(binaries)).toEqual({
      MXC_BIN_DIR: root,
      MXC_FFI_DIR: path.join(root, arch),
    });
  });

  test("rejects an override without mxc_ffi.dll beside it", () => {
    const executorPath = writeRelease(arch, ["wxc-exec.exe"]);

    expect(() => resolveMxcNativeBinaries(executorPath)).toThrow(/mxc_ffi\.dll.*same release/u);
  });

  test("rejects a flat SDK 0.8 style override", () => {
    const executorPath = writeRelease("tools");

    expect(() => resolveMxcNativeBinaries(executorPath)).toThrow(
      new RegExp(`must be in an "${arch}" directory`, "u"),
    );
  });

  test("rejects an override for the other architecture", () => {
    const executorPath = writeRelease(otherArch);

    expect(() => resolveMxcNativeBinaries(executorPath)).toThrow(
      new RegExp(`must be in an "${arch}" directory`, "u"),
    );
  });

  test("rejects a missing override and a differently named executor", () => {
    expect(() => resolveMxcNativeBinaries(path.join(root, arch, "wxc-exec.exe"))).toThrow(
      /not found at configured path/u,
    );
    const renamed = path.join(root, arch, "old-wxc-exec.exe");
    writeRelease(arch, ["old-wxc-exec.exe", "mxc_ffi.dll"]);
    expect(() => resolveMxcNativeBinaries(renamed)).toThrow(/must name wxc-exec\.exe/u);
  });

  test("defaults to the installed SDK architecture directory", () => {
    const require = createRequire(import.meta.url);
    const sdkRoot = path.dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
    const archDir = path.join(sdkRoot, "bin", arch);

    expect(resolveMxcNativeBinaries()).toEqual({
      binDir: path.join(sdkRoot, "bin"),
      archDir,
      executorPath: path.join(archDir, "wxc-exec.exe"),
      nativeLibraryPath: path.join(archDir, "mxc_ffi.dll"),
    });
  });
});
