import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

const NATIVE_PROTOCOL = "NATIVE_PROTOCOL_VERSION=1";
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

function resolveHelperStateFile(name: "helper-ipc-key" | "helper-build.sha256"): string {
  return resolve(homedir(), "Library", "Application Support", "OpenClaw", "FaceTime", name);
}

async function resolveNativeInstall(): Promise<{ buildId: string; capture: string }> {
  for (const directory of NATIVE_DIRS) {
    const capture = resolve(directory, "facetime-audio-capture");
    const helper = resolve(directory, "FaceTimeHelper.dylib");
    const buildIdFile = resolve(directory, "FaceTimeHelper.build-id");
    const protocolFile = resolve(directory, "native-protocol.env");
    try {
      await Promise.all([
        access(capture, constants.X_OK),
        access(helper, constants.R_OK),
        access(buildIdFile, constants.R_OK),
        access(protocolFile, constants.R_OK),
      ]);
      const [buildId, protocol] = await Promise.all([
        readFile(buildIdFile, "utf8").then((value) => value.trim()),
        readFile(protocolFile, "utf8").then((value) => value.trim()),
      ]);
      if (!/^[\da-f]{64}$/u.test(buildId) || protocol !== NATIVE_PROTOCOL) {
        continue;
      }
      return { buildId, capture };
    } catch {
      // Try the other supported Homebrew prefix.
    }
  }
  throw new Error(`Compatible FaceTime native helpers are not installed. Run: ${INSTALL_COMMAND}`);
}

export async function inspectFaceTimeNativePackage(): Promise<boolean> {
  return await resolveNativeInstall().then(
    () => true,
    () => false,
  );
}

export async function inspectFaceTimeArtifacts(): Promise<{
  nativeInstall: boolean;
  stagedHelper: boolean;
  helperKey: boolean;
  helperBuildStamp: boolean;
  stagedHelperDylibs: number;
  cachedDriver: boolean;
}> {
  const readable = async (file: string, mode: number) => {
    try {
      await access(file, mode);
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
    inspectFaceTimeNativePackage(),
    readable(resolveHelperDylib(), constants.R_OK),
    readable(resolveHelperStateFile("helper-ipc-key"), constants.R_OK),
    readable(resolveHelperStateFile("helper-build.sha256"), constants.R_OK),
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

export async function ensureCaptureBinary(): Promise<string> {
  return (await resolveNativeInstall()).capture;
}

export async function ensureHelperArtifacts(params: {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
}): Promise<{ buildId: string; dylib: string; ipcKey: string }> {
  const installation = await resolveNativeInstall();
  const stageScript = resolve(params.pluginRoot, "scripts", "stage-helper.sh");
  const result = await params.runCommandWithTimeout(["/bin/bash", stageScript, "--if-needed"], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime native helper staging failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const dylib = resolveHelperDylib();
  await access(dylib, constants.R_OK);
  const ipcKey = (await readFile(resolveHelperStateFile("helper-ipc-key"), "utf8")).trim();
  const stagedBuildId = (
    await readFile(resolveHelperStateFile("helper-build.sha256"), "utf8")
  ).trim();
  if (!/^[\da-f]{64}$/u.test(ipcKey)) {
    throw new Error("FaceTime helper produced an invalid IPC authentication key");
  }
  if (stagedBuildId !== installation.buildId) {
    throw new Error("Staged FaceTime helper does not match the installed native package");
  }
  return { buildId: installation.buildId, dylib, ipcKey };
}
