// Windows scope → SRT sandbox configuration (Stage S6, design v8 §4/§5/§7).
//
// SRT's Windows enforcement is CLI-based (`srt-win.exe`), not a persistent
// manager process like macOS/Linux. This module translates one OpenClaw scope
// into the Windows enforcement inputs:
//   - a per-scope low-privilege account + sublayer + loopback proxy port range
//     (distinct SID + SID-keyed WFP filter set per scope = the per-scope
//     isolation building block, design v8 §5 "true worker RPC per-scope");
//   - the exec argv wrapper (wrapCommandWithSandboxWindows) the scope reaper
//     spawns with {shell:false};
//   - the helper-path ACL enablement that lets seclogon's
//     CreateProcessWithLogonW open `srt-win.exe` when it lives under a per-user
//     npm-global profile (root-caused on real Windows: without read+execute+
//     traverse for the sandbox account, the two-hop launch fails 0x80070005).
//
// SRT Windows surface pinned to @anthropic-ai/sandbox-runtime@0.0.76
// (dist/sandbox/windows-sandbox-utils.{d.ts,js}). `wrapCommandWithSandboxWindows`
// is only reachable via the subpath (it is not surfaced on the package index),
// so it is imported from there; everything else is on the package root.
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  resolveSrtWin,
  VENDORED_SRT_WIN_EXE,
  type SrtWinSpawn,
} from "@anthropic-ai/sandbox-runtime";
// eslint-disable-next-line import/no-internal-modules -- SRT does not surface the
// Windows exec wrapper on its package index; the subpath is the only entrypoint.
import { wrapCommandWithSandboxWindows } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";

/** Per-scope Windows enforcement identity — distinct account/SID/WFP per scope. */
export type WindowsScopeIdentity = {
  /** Low-privilege local account this scope's children run as. */
  sandboxUser: string;
  /** WFP sublayer GUID isolating this scope's filter set. */
  sublayerGuid: string;
  /** Loopback PERMIT range for this scope's mux proxy (distinct per scope). */
  proxyPortRange: [number, number];
};

/** Windows-specific plugin options (all optional; sane defaults applied). */
export type WindowsPluginOptions = {
  /** Explicit `srt-win.exe` path; defaults to the vendored per-arch binary. */
  srtWinPath?: string;
  /** Named account pool; scope N adopts pool[N % pool.length]. */
  sandboxUsers?: string[];
  /** Base loopback port; scope N gets [base + N*span, base + N*span + span-1]. */
  proxyPortBase?: number;
};

const DEFAULT_SANDBOX_USERS = ["srt-sandbox"] as const;
const DEFAULT_PROXY_PORT_BASE = 60080;
const PROXY_PORT_SPAN = 10;
// Deterministic per-scope sublayer namespace (v5 GUIDv5-style stable derivation).
const SUBLAYER_PREFIX = "6f1e2a10";

/** Resolve the `srt-win` spawn descriptor (explicit path or vendored per-arch). */
export function resolveWindowsSrtWin(options: WindowsPluginOptions): SrtWinSpawn {
  return resolveSrtWin({ path: options.srtWinPath ?? VENDORED_SRT_WIN_EXE });
}

/** Stable 32-bit hash of a scope key (FNV-1a) for deterministic port/guid derivation. */
function hashScope(scopeKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < scopeKey.length; i++) {
    h ^= scopeKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive this scope's Windows enforcement identity deterministically, so the
 * same scope always maps to the same account/sublayer/port range across runs
 * (idempotent install, stable WFP filter set). `index` is the scope's position
 * in the live-scope order; the hash disambiguates when a pool is reused.
 */
export function deriveWindowsScopeIdentity(
  scopeKey: string,
  index: number,
  options: WindowsPluginOptions,
): WindowsScopeIdentity {
  const pool =
    options.sandboxUsers && options.sandboxUsers.length > 0
      ? options.sandboxUsers
      : [...DEFAULT_SANDBOX_USERS];
  const sandboxUser = pool[index % pool.length]!;
  const base = options.proxyPortBase ?? DEFAULT_PROXY_PORT_BASE;
  const slot = index % 64; // bound the port window per host
  const low = base + slot * PROXY_PORT_SPAN;
  const proxyPortRange: [number, number] = [low, low + PROXY_PORT_SPAN - 1];
  const h = hashScope(scopeKey).toString(16).padStart(8, "0");
  // Well-formed 8-4-4-4-12 GUID: prefix / hash / stable / stable / hash+slot.
  const tail = `${h}${(slot & 0xffff).toString(16).padStart(4, "0")}`;
  const sublayerGuid = `{${SUBLAYER_PREFIX}-${h.slice(0, 4)}-4a10-9a10-${tail}}`;
  return { sandboxUser, sublayerGuid, proxyPortRange };
}

/**
 * Grant the sandbox account read+execute+traverse along the resolved
 * `srt-win.exe` path chain (idempotent). A global npm prefix under a user
 * profile is not traversable by the sandbox account, so without this the
 * seclogon two-hop launch cannot open the helper (CreateProcessWithLogonW →
 * 0x80070005). Root-caused and verified on real Windows 11 ARM64.
 */
export function ensureWindowsHelperPathAccess(sandboxUser: string, srtWin: SrtWinSpawn): void {
  const exe = srtWin.exe;
  // Grant RX on each ancestor up to the drive root so the traverse check passes,
  // and (OI)(CI)(RX) on the package dir so the exe and its siblings are readable.
  const ancestors: string[] = [];
  let dir = path.dirname(exe);
  const root = path.parse(exe).root;
  // Walk up to (but not including) the drive root; grant traverse on each.
  while (dir && dir !== root && dir.length > root.length) {
    ancestors.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  for (const p of ancestors.toReversed()) {
    spawnSync("icacls", [p, "/grant", `${sandboxUser}:(RX)`], {
      encoding: "utf8",
      timeout: 15_000,
    });
  }
  // The @anthropic-ai package dir gets inheritable RX so srt-win.exe is readable.
  const pkgDir = exe.includes("@anthropic-ai")
    ? exe.slice(0, exe.indexOf("@anthropic-ai") + "@anthropic-ai".length)
    : path.dirname(exe);
  spawnSync("icacls", [pkgDir, "/grant", `${sandboxUser}:(OI)(CI)(RX)`, "/T"], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** Inputs for building one sandboxed exec argv. */
export type WindowsExecSpecInput = {
  command: string;
  cwd: string;
  allowWrite: readonly string[];
  denyRead?: readonly string[];
  denyWrite?: readonly string[];
  srtWin: SrtWinSpawn;
  /** Proxy env for the sandboxed child (deny-all needs none). */
  httpProxyPort?: number;
  socksProxyPort?: number;
  proxyAuthToken?: string;
  /** Inner shell to run `command` under; defaults to cmd.exe. */
  binShell?: { exe: string; args: readonly string[] };
  /** Extra env vars set inside the sandbox before the command runs. */
  setEnvVars?: Readonly<Record<string, string>>;
};

/**
 * Wrap a command with the Windows sandbox (two-hop CreateProcessWithLogonW under
 * the scope account, restricted token, Job Object kill-on-close). Returns the
 * argv the caller spawns with {shell:false} plus the child env.
 */
export function buildWindowsExecSpec(input: WindowsExecSpecInput): {
  argv: string[];
  env: NodeJS.ProcessEnv;
} {
  const spec = wrapCommandWithSandboxWindows({
    command: input.command,
    cwd: input.cwd,
    allowWrite: [...input.allowWrite],
    denyRead: input.denyRead ? [...input.denyRead] : undefined,
    denyWrite: input.denyWrite ? [...input.denyWrite] : undefined,
    httpProxyPort: input.httpProxyPort,
    socksProxyPort: input.socksProxyPort,
    proxyAuthToken: input.proxyAuthToken,
    setEnvVars: input.setEnvVars,
    srtWin: input.srtWin,
    binShell: input.binShell
      ? { exe: input.binShell.exe, args: [...input.binShell.args] }
      : undefined,
    quiet: true,
  });
  return { argv: [...spec.argv], env: spec.env };
}
