import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

const EXECUTOR_NAME = "wxc-exec.exe";
const NATIVE_LIBRARY_NAME = "mxc_ffi.dll";

/**
 * Native MXC components the plugin pins for one launcher run.
 *
 * MXC SDK 1.0 runs piped commands through the in-process `mxc_ffi` library
 * and ProcessContainer PTY commands through `wxc-exec`. It silently falls back
 * to its packaged binaries when `MXC_FFI_DIR`/`MXC_BIN_DIR` do not resolve, so
 * the plugin validates both files from one directory and pins both variables.
 */
export type MxcNativeBinaries = {
  /** `MXC_BIN_DIR`: the SDK appends `<arch>\wxc-exec.exe`. */
  binDir: string;
  /** `MXC_FFI_DIR`: the SDK appends `mxc_ffi.dll`. */
  archDir: string;
  executorPath: string;
  nativeLibraryPath: string;
};

function sdkArch(): "arm64" | "x64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function binariesInArchDir(archDir: string): MxcNativeBinaries {
  return {
    binDir: path.dirname(archDir),
    archDir,
    executorPath: path.join(archDir, EXECUTOR_NAME),
    nativeLibraryPath: path.join(archDir, NATIVE_LIBRARY_NAME),
  };
}

function resolveSdkArchDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const sdkRoot = path.dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
    return path.join(sdkRoot, "bin", sdkArch());
  } catch {
    return null;
  }
}

function resolveOverride(configOverride: string): MxcNativeBinaries {
  const executorPath = path.win32.isAbsolute(configOverride)
    ? configOverride
    : path.resolve(configOverride);
  const archDir = path.dirname(executorPath);
  const arch = sdkArch();
  const expectedLayout = `<directory>\\${arch}\\${EXECUTOR_NAME} with ${NATIVE_LIBRARY_NAME} beside it`;
  if (path.basename(executorPath).toLowerCase() !== EXECUTOR_NAME) {
    throw new Error(
      `MXC binary override ${configOverride} must name ${EXECUTOR_NAME} (${expectedLayout}).`,
    );
  }
  if (!isRegularFile(executorPath)) {
    throw new Error(`MXC binary not found at configured path: ${configOverride}`);
  }
  if (path.basename(archDir).toLowerCase() !== arch) {
    throw new Error(
      `MXC binary override ${configOverride} must be in an "${arch}" directory matching this host (${expectedLayout}).`,
    );
  }
  const binaries = binariesInArchDir(archDir);
  if (!isRegularFile(binaries.nativeLibraryPath)) {
    throw new Error(
      `MXC native library ${binaries.nativeLibraryPath} is missing next to the configured ` +
        `mxcBinaryPath. MXC SDK 1.0 needs both files from the same release (${expectedLayout}).`,
    );
  }
  return binaries;
}

/**
 * Resolves the native MXC components for the configured override or the
 * installed SDK. Throws instead of selecting a partial or mixed layout.
 */
export function resolveMxcNativeBinaries(configOverride?: string): MxcNativeBinaries {
  if (configOverride) {
    return resolveOverride(configOverride);
  }
  const archDir = resolveSdkArchDir();
  const binaries = archDir ? binariesInArchDir(archDir) : undefined;
  const missing = binaries
    ? [binaries.executorPath, binaries.nativeLibraryPath].filter((file) => !isRegularFile(file))
    : [];
  if (!binaries || missing.length > 0) {
    throw new Error(
      `MXC native components were not found${missing.length > 0 ? ` (${missing.join(", ")})` : ""}. ` +
        `Install @microsoft/mxc-sdk or set mxcBinaryPath in config.`,
    );
  }
  return binaries;
}

/** Launcher environment entries that pin the SDK to the validated components. */
export function buildMxcNativeEnv(binaries: MxcNativeBinaries): Record<string, string> {
  return {
    MXC_BIN_DIR: binaries.binDir,
    MXC_FFI_DIR: binaries.archDir,
  };
}
