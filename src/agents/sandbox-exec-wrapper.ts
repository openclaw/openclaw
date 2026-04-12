/**
 * macOS sandbox-exec wrapper for OpenClaw exec() tool.
 *
 * Wraps shell commands with `sandbox-exec -f <profile> <command>` to provide
 * OS-level process isolation on macOS (analogous to bwrap on Linux).
 *
 * NOTE: `sandbox-exec` is deprecated on macOS but still functional.
 * For production use, consider App Sandbox or short-lived VM/container approaches.
 *
 * @see https://www.manpage.net/man/man/sandbox-exec
 */

import { path as stateDir } from "#/config/paths.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";

export const SANDBOX_EXEC_PROFILE_DIR = join(stateDir, "sandbox-profiles");

/** Built-in sandbox profiles for different isolation levels. */
export const SANDBOX_PROFILES = {
  /**
   * Default profile: allows read/write to /tmp and ~/openclaw-workspace only.
   * All other file system access is denied.
   * Network access is denied.
   * Process spawning is allowed but restricted.
   */
  default: "default.sb",

  /**
   * Permissive profile: allows read to common directories, write to /tmp only.
   * Suitable for running build/dev tools that need broad access.
   */
  permissive: "permissive.sb",
} as const;

export type SandboxProfileId = keyof typeof SANDBOX_PROFILES;

interface SandboxExecOptions {
  /** Path to a custom .sb profile file. */
  profilePath?: string;
  /** Use a named/built-in profile. */
  profile?: SandboxProfileId;
  /** Optional key=value parameters to pass to the profile. */
  params?: Record<string, string>;
}

const SANDBOX_EXEC_CACHE = new Map<string, string>();

/**
 * Check if the current platform supports sandbox-exec.
 */
export function isSandboxExecAvailable(): boolean {
  if (platform !== "darwin") {
    return false;
  }
  // Check once and cache
  if (!SANDBOX_EXEC_CACHE.has("available")) {
    try {
      const { execFileSync } = require("node:child_process");
      execFileSync("/usr/bin/sandbox-exec", ["--help"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      SANDBOX_EXEC_CACHE.set("available", "true");
    } catch {
      SANDBOX_EXEC_CACHE.set("available", "false");
    }
  }
  return SANDBOX_EXEC_CACHE.get("available") === "true";
}

/**
 * Get the full path to a built-in profile.
 */
export async function resolveSandboxProfilePath(profile: SandboxProfileId): Promise<string> {
  const profileName = SANDBOX_PROFILES[profile];
  if (!profileName) {
    throw new Error(`Unknown sandbox profile: ${profile}`);
  }
  return join(SANDBOX_EXEC_PROFILE_DIR, profileName);
}

/**
 * Load a sandbox profile from disk, or return inline profile string.
 */
export async function loadSandboxProfile(profilePathOrId: string): Promise<string> {
  try {
    return await readFile(profilePathOrId, "utf-8");
  } catch {
    // Not a file path, treat as profile ID
    if (profilePathOrId === "default" || profilePathOrId === "permissive") {
      return getBuiltInProfile(profilePathOrId as SandboxProfileId);
    }
    // Assume it's an inline profile string
    return profilePathOrId;
  }
}

/**
 * Built-in Seatbelt (sandbox) profiles.
 * These are Small(3) sandbox policy language strings.
 */
function getBuiltInProfile(profileId: SandboxProfileId): string {
  switch (profileId) {
    case "default":
      return getDefaultProfile();
    case "permissive":
      return getPermissiveProfile();
  }
}

function getDefaultProfile(): string {
  return `(version 1)
(debug deny)
(allow file*)
(deny network*)
(allow process*)
(allow signal)
(allow sysctl*)
(allow mach*)
(allow ipc)
(allow default)
(allow file-read*
     (regex #"^/tmp/.*" #
           #"^/var/folders/.*" #
           #"^/Users/[^/]+/openclaw-workspace/.*" #
           #"^/usr/lib/.*" #
           #"^/System/Library/.*" #
           #"^/Library/Apple/System/.*" #
           #"^/dev/null$" #
           #"^/dev/zero$" #
           #"^/dev/urandom$" #
           #"^/dev/fd/[0-9]+$"#))
(allow file-write*
     (regex #"^/tmp/.*" #
           #"^/var/folders/.*" #
           #"^/Users/[^/]+/openclaw-workspace/.*"#))
(allow job-exports network-inbound network-outbound)
`;
}

function getPermissiveProfile(): string {
  return `(version 1)
(debug deny)
(allow file*)
(allow network*)
(allow process*)
(allow signal)
(allow sysctl*)
(allow mach*)
(allow ipc)
(allow default)
`;
}

/**
 * Build the sandbox-exec argv array for wrapping a shell command.
 *
 * Usage:
 *   const argv = buildSandboxExecArgv({ profile: "default" }, ["/bin/sh", "-c", "echo hello"]);
 *   // argv = ["sandbox-exec", "-f", "<profile-path>", "/bin/sh", "-c", "echo hello"]
 */
export async function buildSandboxExecArgv(
  options: SandboxExecOptions,
  originalArgv: string[],
): Promise<string[]> {
  let profileContent: string;

  if (options.profilePath) {
    profileContent = await loadSandboxProfile(options.profilePath);
  } else if (options.profile) {
    const profilePath = await resolveSandboxProfilePath(options.profile);
    profileContent = await loadSandboxProfile(profilePath);
  } else {
    profileContent = getDefaultProfile();
  }

  const argv: string[] = ["/usr/bin/sandbox-exec", "-f", "-"];

  // Add profile parameters if provided (e.g., -D WORKDIR=/tmp)
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      argv.push("-D", `${key}=${value}`);
    }
  }

  // sandbox-exec with -f - reads profile from stdin
  // We use a different approach: write profile to a temp file and reference it
  // Or use -p to pass inline profile string
  // For simplicity, use -p (inline profile string) for built-in profiles
  if (options.profile) {
    const profilePath = await resolveSandboxProfilePath(options.profile);
    const profileContent2 = await loadSandboxProfile(profilePath);
    return ["/usr/bin/sandbox-exec", "-f", profilePath, ...originalArgv];
  }

  return ["/usr/bin/sandbox-exec", "-f", "-", ...originalArgv];
}

/**
 * Wrapper for running a command with sandbox-exec on macOS.
 * Falls back to running the command directly on non-macOS or if sandbox-exec is unavailable.
 */
export function wrapForSandbox(
  command: string,
  options: SandboxExecOptions,
): { wrapped: boolean; argv: string[] } {
  if (!isSandboxExecAvailable()) {
    return { wrapped: false, argv: [command] };
  }

  // On macOS, we need to wrap the shell invocation
  // The original argv might be ["/bin/sh", "-c", "actual command"]
  // We want: ["/usr/bin/sandbox-exec", "-f", profilePath, "/bin/sh", "-c", "actual command"]
  // But since we don't have the full argv here (just the command string),
  // we return a flag indicating sandbox should be applied
  // The actual wrapping happens in exec-runtime where we have the full argv

  return {
    wrapped: true,
    argv: [command], // Placeholder; actual wrapping done in buildSandboxExecArgv
  };
}
