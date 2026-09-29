import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
const NATIVE_DIRS = [
  "/opt/homebrew/opt/openclaw-facetime/libexec",
  "/usr/local/opt/openclaw-facetime/libexec",
] as const;
const INSTALL_COMMAND = "brew install openclaw/tap/openclaw-facetime";

function resolveHelperDylib(): string {
  return resolve(
    homedir(),
    "Library",
    "Containers",
    "com.apple.FaceTime",
    "Data",
    "tmp",
    "FaceTimeHelper.dylib",
  );
}

function resolveHelperIpcKey(): string {
  return resolve(
    homedir(),
    "Library",
    "Application Support",
    "OpenClaw",
    "FaceTime",
    "helper-ipc-key",
  );
}

function resolveHelperBuildStamp(): string {
  return resolve(
    homedir(),
    "Library",
    "Application Support",
    "OpenClaw",
    "FaceTime",
    "helper-build.sha256",
  );
}

async function resolveNativeInstall(params: {
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{ capture: string; directory: string }> {
  const checkAccess = params.access ?? access;
  for (const directory of NATIVE_DIRS) {
    const capture = resolve(directory, "facetime-audio-capture");
    try {
      await checkAccess(capture, constants.X_OK);
      return { capture, directory };
    } catch {
      // Try the other supported Homebrew prefix.
    }
  }
  throw new Error(`Compatible FaceTime audio capture is not installed. Run: ${INSTALL_COMMAND}`);
}

export async function inspectFaceTimeNativePackage(
  params: {
    access?: typeof access;
    readFile?: typeof readFile;
  } = {},
): Promise<boolean> {
  return await resolveNativeInstall(params).then(
    () => true,
    () => false,
  );
}

export async function inspectFaceTimeArtifacts(params: {
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{
  nativeInstall: boolean;
  stagedHelper: boolean;
  helperKey: boolean;
  helperBuildStamp: boolean;
  stagedHelperDylibs: number;
  cachedDriver: boolean;
}> {
  const checkAccess = params.access ?? access;
  const readable = async (file: string, mode: number) => {
    try {
      await checkAccess(file, mode);
      return true;
    } catch {
      return false;
    }
  };
  const helperTempDirs = ["com.apple.FaceTime", "com.apple.mobilephone"].map((bundle) =>
    resolve(homedir(), "Library", "Containers", bundle, "Data", "tmp"),
  );
  const countHelpers = async (directory: string) => {
    try {
      return (await readdir(directory)).filter(
        (name) => name.startsWith("FaceTimeHelper") && name.endsWith(".dylib"),
      ).length;
    } catch {
      return 0;
    }
  };
  const [
    nativeInstall,
    stagedHelper,
    helperKey,
    helperBuildStamp,
    stagedHelperDylibs,
    cachedDriver,
  ] = await Promise.all([
    inspectFaceTimeNativePackage(params),
    readable(resolveHelperDylib(), constants.R_OK),
    readable(resolveHelperIpcKey(), constants.R_OK),
    readable(resolveHelperBuildStamp(), constants.R_OK),
    Promise.all(helperTempDirs.map(countHelpers)).then((counts) =>
      counts.reduce((total, count) => total + count, 0),
    ),
    readable(
      resolve(
        homedir(),
        "Library",
        "Caches",
        "OpenClaw",
        "FaceTime",
        "driver",
        "OpenClawBridge.driver",
      ),
      constants.R_OK,
    ),
  ]);
  return {
    nativeInstall,
    stagedHelper,
    helperKey,
    helperBuildStamp,
    stagedHelperDylibs,
    cachedDriver,
  };
}

export async function ensureCaptureBinary(
  params: {
    access?: typeof access;
    readFile?: typeof readFile;
  } = {},
): Promise<string> {
  return (await resolveNativeInstall(params)).capture;
}
