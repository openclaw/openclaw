import fs from "node:fs";
import path from "node:path";
// Translate an OpenClaw sandbox scope into an SRT runtime config.
//
// Encodes the file-system model verified on macOS Seatbelt: SRT reads are deny-then-allow (open by default, narrowed via
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
import { resolveReadOnlyWorkspaceSkillMounts } from "openclaw/plugin-sdk/sandbox";
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
  readOnlyResourceMounts?: readonly { hostPath: string; containerPath: string }[];
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

/** Workspace permissions never promote the hidden host or managed skills. */
export function resolveWritableRoots(
  scope: SrtScopePolicyInput,
  extraWritablePaths: readonly string[],
): string[] {
  return dedupeAbsolute([
    scope.workspaceAccess !== "ro" ? scope.workspaceDir : undefined,
    scope.workspaceAccess === "rw" ? scope.agentWorkspaceDir : undefined,
    ...extraWritablePaths,
  ]);
}

function withCanonicalAliases(paths: Array<string | undefined>): string[] {
  return dedupeAbsolute(
    paths.flatMap((entry) => {
      if (!entry) {
        return [];
      }
      try {
        return [entry, fs.realpathSync(entry)];
      } catch {
        // Writable descendants may not exist yet. Resolve their admitted
        // ancestor so a symlink cannot hide a protected root from filtering.
        const api = entry.startsWith("/") ? path.posix : path.win32;
        let parent = api.dirname(entry);
        const suffix = [api.basename(entry)];
        while (parent !== api.dirname(parent)) {
          try {
            return [entry, api.join(fs.realpathSync(parent), ...suffix)];
          } catch {
            suffix.unshift(api.basename(parent));
            parent = api.dirname(parent);
          }
        }
        return [entry];
      }
    }),
  );
}

/** A single policy snapshot owns command, broker and file-tool permissions. */
export function buildSrtFilesystemPolicy(
  scope: SrtScopePolicyInput,
  extraWritablePaths: readonly string[],
): SandboxRuntimeConfig["filesystem"] {
  const skills = resolveReadOnlyWorkspaceSkillMounts({ ...scope, workdir: scope.workspaceDir });
  const denyRead = withCanonicalAliases(
    scope.workspaceAccess === "none" ? [scope.agentWorkspaceDir] : [],
  );
  const denyWrite = withCanonicalAliases([
    ...(scope.workspaceAccess === "ro" ? [scope.workspaceDir, scope.agentWorkspaceDir] : []),
    ...(scope.workspaceAccess === "none" ? [scope.agentWorkspaceDir] : []),
    ...skills.map((mount) => mount.hostPath),
    ...(scope.readOnlyResourceMounts ?? []).map((mount) => mount.hostPath),
  ]);
  const within = (candidate: string, root: string) => {
    const api = candidate.startsWith("/") ? path.posix : path.win32;
    const relative = api.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative))
    );
  };
  const allowWrite = resolveWritableRoots(scope, extraWritablePaths).flatMap((candidate) => {
    const aliases = withCanonicalAliases([candidate]);
    // Linux binds writable roots after hiding reads. An ancestor writable
    // mount would restore a hidden host workspace, so reject both overlaps.
    if (
      aliases.some(
        (alias) =>
          denyWrite.some((root) => within(alias, root)) ||
          denyRead.some((root) => within(root, alias)),
      )
    ) {
      return [];
    }
    return aliases;
  });
  return {
    allowRead: [],
    denyRead,
    allowWrite: dedupeAbsolute(allowWrite),
    denyWrite,
  };
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
 * Hidden host workspaces are denied reads; other non-writable paths remain
 * readable. Explicit readonly boundaries override every writable root.
 */
export function buildSrtRuntimeConfig(
  scope: SrtScopePolicyInput,
  pluginConfig: ResolvedSrtPluginConfig,
): SandboxRuntimeConfig {
  return {
    network: resolveNetwork(pluginConfig.network, pluginConfig.allowedDomains),
    filesystem: buildSrtFilesystemPolicy(scope, pluginConfig.writablePaths),
  };
}
