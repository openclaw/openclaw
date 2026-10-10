import path from "node:path";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

const NODE_BINARY_LOOKUP_TIMEOUT_MS = 5_000;

function isNodeExecPath(execPath: string, platform: NodeJS.Platform): boolean {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const basename = pathModule.basename(execPath).toLowerCase();
  return (
    basename === "node" ||
    basename === "node.exe" ||
    basename === "nodejs" ||
    basename === "nodejs.exe"
  );
}

export async function resolveQaNodeExecPath(params?: {
  execPath?: string;
  platform?: NodeJS.Platform;
  versions?: NodeJS.ProcessVersions;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const execPath = params?.execPath ?? process.execPath;
  const platform = params?.platform ?? process.platform;
  const versions = params?.versions ?? process.versions;
  if (typeof versions.bun !== "string" && isNodeExecPath(execPath, platform)) {
    return execPath;
  }

  const locator =
    platform === "win32" ? resolveQaWindowsSystem32ExePath("where.exe", params?.env) : "which";
  const result = await runExec(locator, ["node"], {
    baseEnv: params?.env,
    logOutput: false,
    timeoutMs: NODE_BINARY_LOOKUP_TIMEOUT_MS,
  }).catch(() => undefined);

  const resolved = result?.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!resolved) {
    throw new Error(
      "Node not found in PATH. QA live lanes require Node for child gateway and CLI processes.",
    );
  }
  return resolved;
}
