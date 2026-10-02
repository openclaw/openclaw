import path from "node:path";
// Translate an OpenClaw sandbox scope into an SRT runtime config.
//
// Encodes the file-system model verified during research (XIN-1912, macOS
// Seatbelt 8/8): SRT reads are deny-then-allow (open by default, narrowed via
// denyRead) and writes are allow-only (denied by default, widened via the
// allowWrite allowlist, denyWrite takes precedence). "Specified directory
// writable, everything else read-only" therefore reduces to a single
// allowWrite allowlist over the scope's workspace directories with reads left
// unrestricted. Enforcement is kernel-level (Seatbelt on macOS) and covers the
// whole process tree, so exec-spawned children are constrained too.
//
// SRT config surface pinned to @anthropic-ai/sandbox-runtime@0.0.76
// (src/sandbox/sandbox-config.ts:1408-1426 — NetworkConfig / FilesystemConfig /
// SandboxRuntimeConfig). Consumed by SandboxManager.initialize() /
// wrapWithSandboxArgv() (src/sandbox/sandbox-manager.ts:630, :1800).
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ResolvedSrtPluginConfig, SrtNetworkMode } from "./config.js";

/** The OpenClaw scope inputs that determine the SRT file/network policy. */
export type SrtScopePolicyInput = {
  /** Primary workspace directory for this scope. */
  workspaceDir: string;
  /** Agent workspace mirror directory. */
  agentWorkspaceDir: string;
  /** Optional skills workspace directory. */
  skillsWorkspaceDir?: string;
  /** Whether the workspace is writable ("rw"), read-only ("ro"), or hidden. */
  workspaceAccess: "none" | "ro" | "rw";
};

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function dedupeAbsolute(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) {
      continue;
    }
    const value = raw.trim();
    if (!value || !isAbsolutePath(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Compute the writable allowlist for a scope.
 *
 * The workspace directory is only writable when the scope grants "rw"; a "ro"
 * or "none" scope keeps the workspace read-only (writes fail closed at the
 * kernel layer). The agent workspace and skills mirror plus any configured
 * extra paths are always added so the backend can stage its own scratch state.
 */
export function resolveWritableRoots(
  scope: SrtScopePolicyInput,
  extraWritablePaths: readonly string[],
): string[] {
  const roots: Array<string | undefined> = [
    scope.workspaceAccess === "rw" ? scope.workspaceDir : undefined,
    scope.agentWorkspaceDir,
    scope.skillsWorkspaceDir,
    ...extraWritablePaths,
  ];
  return dedupeAbsolute(roots);
}

function resolveNetwork(
  mode: SrtNetworkMode,
  allowedDomains: readonly string[],
): SandboxRuntimeConfig["network"] {
  // SRT treats an explicitly empty allowedDomains array as deny-all before it
  // reaches filterRequest. Use its wildcard rule for the opt-in open posture so
  // the initialized proxy and generated platform profile both admit egress.
  if (mode === "allow") {
    return {
      allowedDomains: ["*"],
      deniedDomains: [],
      strictAllowlist: true,
    };
  }
  // S5 P0 global allowlist (v1 plan §6.4 P0): with a non-empty allowlist, permit
  // those domains and deny everything else. On macOS this is kernel-enforced; on
  // Linux the kernel boundary is bwrap --unshare-net (deny-all) and the domain
  // allowlist is applied at the SRT host proxy (see config.ts allowedDomains and
  // the AC-L3 limitation note). Empty allowlist => strict deny-all (S1 default).
  if (allowedDomains.length > 0) {
    return { allowedDomains: [...allowedDomains], deniedDomains: [], strictAllowlist: true };
  }
  return { allowedDomains: [], deniedDomains: [], strictAllowlist: true };
}

/**
 * Build the SRT runtime config for one scope.
 *
 * Reads are left unrestricted (allowRead/denyRead empty) so non-writable paths
 * remain readable — the "rest read-only" half of the guarantee. Writes are
 * confined to {@link resolveWritableRoots}.
 */
export function buildSrtRuntimeConfig(
  scope: SrtScopePolicyInput,
  pluginConfig: ResolvedSrtPluginConfig,
): SandboxRuntimeConfig {
  const allowWrite = resolveWritableRoots(scope, pluginConfig.writablePaths);
  return {
    network: resolveNetwork(pluginConfig.network, pluginConfig.allowedDomains),
    filesystem: {
      allowRead: [],
      denyRead: [],
      allowWrite,
      denyWrite: [],
    },
  };
}
