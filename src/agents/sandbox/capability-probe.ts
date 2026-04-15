import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const USERNS_CLONE_PROC_PATH = "/proc/sys/kernel/unprivileged_userns_clone";
const MAX_USER_NAMESPACES_PROC_PATH = "/proc/sys/user/max_user_namespaces";

type UserNamespaceSupport = "enabled" | "disabled" | "unknown";

export type SandboxCapabilityProbeResult = {
  platform: NodeJS.Platform;
  dockerCliAvailable: boolean;
  unshareBinaryAvailable: boolean;
  userNamespaceSupport: UserNamespaceSupport;
  supportsSandbox: boolean;
};

export type SandboxCapabilityProbeOptions = {
  platform?: NodeJS.Platform;
  hasCommand?: (command: "docker" | "unshare") => boolean;
  readProcFile?: (path: string) => string | null;
};

function defaultHasCommand(command: "docker" | "unshare"): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function defaultReadProcFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function resolveUserNamespaceSupport(readProcFile: (path: string) => string | null): UserNamespaceSupport {
  const unprivilegedClone = readProcFile(USERNS_CLONE_PROC_PATH)?.trim();
  if (unprivilegedClone === "1") {
    return "enabled";
  }
  if (unprivilegedClone === "0") {
    return "disabled";
  }

  const maxNamespacesRaw = readProcFile(MAX_USER_NAMESPACES_PROC_PATH)?.trim();
  if (!maxNamespacesRaw) {
    return "unknown";
  }
  const maxNamespaces = Number.parseInt(maxNamespacesRaw, 10);
  if (!Number.isFinite(maxNamespaces)) {
    return "unknown";
  }
  return maxNamespaces > 0 ? "enabled" : "disabled";
}

/**
 * Runtime capability probe used by CI/doctor checks to decide whether
 * sandboxed execution is expected to work on this host.
 */
export function probeSandboxCapabilities(
  options: SandboxCapabilityProbeOptions = {},
): SandboxCapabilityProbeResult {
  const platform = options.platform ?? process.platform;
  const hasCommand = options.hasCommand ?? defaultHasCommand;
  const readProcFile = options.readProcFile ?? defaultReadProcFile;

  const dockerCliAvailable = hasCommand("docker");
  const unshareBinaryAvailable = platform === "linux" ? hasCommand("unshare") : false;
  const userNamespaceSupport =
    platform === "linux" ? resolveUserNamespaceSupport(readProcFile) : "unknown";

  const supportsSandbox =
    dockerCliAvailable ||
    (platform === "linux" && unshareBinaryAvailable && userNamespaceSupport !== "disabled");

  return {
    platform,
    dockerCliAvailable,
    unshareBinaryAvailable,
    userNamespaceSupport,
    supportsSandbox,
  };
}

export function supportsSandboxEnvironment(options: SandboxCapabilityProbeOptions = {}): boolean {
  return probeSandboxCapabilities(options).supportsSandbox;
}
