import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export function resolvePluginRoot(entryUrl: string): string {
  const entryDirectory = dirname(fileURLToPath(entryUrl));
  return entryDirectory.endsWith("/dist") ? resolve(entryDirectory, "..") : entryDirectory;
}

export function resolveCaptureBinary(pluginRoot: string): string {
  return resolve(pluginRoot, "native", ".build", "release", "facetime-audio-capture");
}

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

export async function ensureCaptureBinary(params: {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  access?: typeof access;
}): Promise<string> {
  const binary = resolveCaptureBinary(params.pluginRoot);
  const checkAccess = params.access ?? access;
  try {
    await checkAccess(binary, constants.X_OK);
    return binary;
  } catch {
    // OpenClaw installs npm plugins with lifecycle scripts disabled. Build the
    // signed helper from the packaged Swift source on first activation instead.
  }
  const buildScript = resolve(params.pluginRoot, "scripts", "build-capture.sh");
  const result = await params.runCommandWithTimeout(["/bin/bash", buildScript], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime capture helper build failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  await checkAccess(binary, constants.X_OK);
  return binary;
}

export async function ensureHelperArtifacts(params: {
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
  access?: typeof access;
  readFile?: typeof readFile;
}): Promise<{ buildId: string; dylib: string; ipcKey: string }> {
  const buildScript = resolve(params.pluginRoot, "scripts", "build-helper-macabi.sh");
  const result = await params.runCommandWithTimeout(["/bin/bash", buildScript, "--if-needed"], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `FaceTime injected helper build failed: ${result.stderr || result.stdout || `exit ${result.code}`}`,
    );
  }
  const dylib = resolveHelperDylib();
  await (params.access ?? access)(dylib, constants.R_OK);
  const ipcKey = (await (params.readFile ?? readFile)(resolveHelperIpcKey(), "utf8")).trim();
  if (!/^[\da-f]{64}$/u.test(ipcKey)) {
    throw new Error("FaceTime helper build produced an invalid IPC authentication key");
  }
  const buildId = (await (params.readFile ?? readFile)(resolveHelperBuildStamp(), "utf8")).trim();
  if (!/^[\da-f]{64}$/u.test(buildId)) {
    throw new Error("FaceTime helper build produced an invalid build identity");
  }
  return { buildId, dylib, ipcKey };
}
