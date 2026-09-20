// Fail-closed dependency probe for the SRT sandbox backend.
//
// Design posture (v8 §7 / v7 §2): the backend must refuse to register/create
// rather than silently degrade or fall back to the host when the sandbox
// cannot be enforced. The probe therefore throws — never returns a "disabled"
// handle — when the platform or the SRT toolchain is unusable.
//
// S1 landed the macOS (Seatbelt) gate. S5 (design v8 §5/§7, v1 plan §8) adds the
// Linux (bwrap + seccomp + netns) gate: the same fail-closed probe now also runs
// on Linux, where SRT's own checkDependenciesAsync() reports bubblewrap / socat /
// ripgrep availability. Two Linux-specific hardenings sit on top of it:
//   1. Actionable install guidance. SRT surfaces terse tokens ("bubblewrap
//      (bwrap) not installed"); the probe maps them to concrete apt/dnf hints so
//      the fail-closed error tells the operator exactly what to install.
//   2. seccomp fail-closed. SRT treats a missing seccomp helper as a *warning*
//      (degraded: unix-socket access unrestricted). On Linux the sandbox must not
//      start without kernel-level seccomp enforcement, so the probe promotes that
//      warning to a fail-closed error. macOS Seatbelt never uses the seccomp
//      helper, so this never fires there — darwin behaviour is unchanged.
// Windows (S6) stays gated.
//
// SRT probe surface pinned to @anthropic-ai/sandbox-runtime@0.0.76:
//   SandboxManager.isSupportedPlatform()   (src/sandbox/sandbox-manager.ts:755)
//   SandboxManager.checkDependenciesAsync() (src/sandbox/sandbox-manager.ts:832)
//     → { errors, warnings }; on Linux the errors/warnings originate in
//       checkLinuxDependencies() (src/sandbox/linux-sandbox-utils.ts:419) —
//       a non-empty `errors` means the sandbox cannot run.
import {
  SandboxManager,
  VENDORED_SRT_WIN_EXE,
  checkWindowsDependenciesAsync,
  resolveSrtWin,
  type SrtWinSpawn,
} from "@anthropic-ai/sandbox-runtime";

/**
 * Platforms the SRT backend enforces today: macOS Seatbelt (S1), Linux
 * bwrap + seccomp + netns (S5), and Windows low-privilege account + NTFS ACL +
 * WFP + worker-RPC per-scope (S6).
 */
const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);

export class SrtSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SrtSandboxUnavailableError";
  }
}

function platformGuidance(platform: NodeJS.Platform): string {
  return `Platform "${platform}" is not supported by the SRT sandbox backend.`;
}

/**
 * Windows dependency guidance. SRT's Windows probe reports missing pieces of the
 * low-priv-account / WFP toolchain (the vendored `srt-win.exe`, the VC++ runtime
 * it links, the Secondary Logon service the two-hop launch needs). Surface them
 * verbatim plus the fail-closed note.
 */
function windowsGuidance(problems: readonly string[]): string {
  return (
    `${problems.join("; ")}. Ensure the vendored srt-win.exe is present (reinstall ` +
    `@anthropic-ai/sandbox-runtime), the Microsoft Visual C++ 2015-2022 Redistributable is ` +
    `installed, and the Secondary Logon (seclogon) service is enabled. The SRT sandbox refuses ` +
    `to run commands unsandboxed (fail-closed).`
  );
}

/**
 * Map an SRT Linux dependency problem to a concrete package name. SRT reports
 * terse tokens; the operator needs to know what to install.
 */
const LINUX_DEP_PACKAGES: Array<{ match: RegExp; pkg: string }> = [
  { match: /bubblewrap|bwrap/i, pkg: "bubblewrap" },
  { match: /socat/i, pkg: "socat" },
  { match: /ripgrep|\brg\b/i, pkg: "ripgrep" },
];

/**
 * Build an actionable install-guidance sentence for the Linux dependencies the
 * SRT probe reported as missing/unusable. A missing seccomp helper is not an
 * OS package (it ships vendored with @anthropic-ai/sandbox-runtime), so it gets
 * a reinstall hint instead of an apt/dnf line.
 */
function linuxInstallGuidance(problems: readonly string[]): string {
  const packages = new Set<string>();
  let seccompMissing = false;
  for (const problem of problems) {
    if (/seccomp/i.test(problem)) {
      seccompMissing = true;
    }
    for (const { match, pkg } of LINUX_DEP_PACKAGES) {
      if (match.test(problem)) {
        packages.add(pkg);
      }
    }
  }
  const hints: string[] = [];
  if (packages.size > 0) {
    const list = Array.from(packages).sort().join(" ");
    hints.push(
      `Install the missing Linux sandbox dependencies and retry — Debian/Ubuntu: 'sudo apt-get install ${list}'; Fedora/RHEL: 'sudo dnf install ${list}'.`,
    );
  }
  if (seccompMissing) {
    hints.push(
      "The seccomp helper ships with @anthropic-ai/sandbox-runtime@0.0.76 — reinstall the package so the vendored apply-seccomp binary is present.",
    );
  }
  hints.push("The SRT sandbox refuses to run commands unsandboxed (fail-closed).");
  return hints.join(" ");
}

/**
 * Verify the SRT sandbox can be enforced on this host. Throws
 * {@link SrtSandboxUnavailableError} (fail-closed) when it cannot.
 *
 * Runs BEFORE the backend factory constructs a scope (see backend.ts
 * createSrtSandboxBackendFactory) so a host missing bwrap/socat/ripgrep/seccomp
 * (Linux) or srt-win.exe / VC++ runtime / seclogon (Windows) never gets a handle
 * that could execute a command outside the sandbox.
 *
 * `srtWin` is required on Windows (the SRT Windows probe spawns `srt-win.exe`);
 * it is ignored on macOS/Linux.
 */
export async function assertSrtSandboxAvailable(srtWin?: SrtWinSpawn): Promise<void> {
  const platform = process.platform;
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new SrtSandboxUnavailableError(
      `SRT sandbox backend cannot start: ${platformGuidance(platform)}`,
    );
  }
  if (platform === "win32") {
    // Windows enforcement is CLI-based (srt-win.exe), not the SandboxManager
    // path used by macOS/Linux — probe it directly.
    const resolved = srtWin ?? resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
    const check = await checkWindowsDependenciesAsync({ srtWin: resolved });
    if (check.errors.length > 0) {
      throw new SrtSandboxUnavailableError(
        `SRT sandbox backend cannot start: missing Windows dependencies — ${windowsGuidance(check.errors)}`,
      );
    }
    return;
  }
  if (!SandboxManager.isSupportedPlatform()) {
    throw new SrtSandboxUnavailableError(
      "SRT sandbox backend cannot start: the sandbox runtime reports this platform as unsupported.",
    );
  }
  const check = await SandboxManager.checkDependenciesAsync();
  const problems = [...check.errors];
  if (platform === "linux") {
    // AC-L6 fail-closed: promote SRT's degraded-seccomp warning to a hard error.
    const seccompWarning = check.warnings.find((warning) => /seccomp/i.test(warning));
    if (seccompWarning) {
      problems.push(`seccomp helper unavailable — ${seccompWarning}`);
    }
  }
  if (problems.length > 0) {
    const base = `SRT sandbox backend cannot start: missing dependencies — ${problems.join("; ")}`;
    const guidance = platform === "linux" ? ` ${linuxInstallGuidance(problems)}` : "";
    throw new SrtSandboxUnavailableError(`${base}${guidance}`);
  }
}
