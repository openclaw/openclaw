import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";

type ReadinessDeps = {
  execFileSync: typeof execFileSync;
};

const DEFAULT_DEPS: ReadinessDeps = { execFileSync };

// Fields this plugin reads from `wxc-exec --probe`; other probe facts are ignored.
const MxcProbeOutputSchema = z.object({
  tier: z.string().optional(),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
});

function resolveWindowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return path.win32.join(systemRoot || "C:\\Windows", "System32", name);
}

// MXC owns host support detection: `wxc-exec --probe` reports the isolation tier a
// sandbox would use, without spawning one. It still exits 0 when detection fails,
// reporting an `error` and no tier, so a missing tier means this host cannot run
// MXC sandboxes. Probe the same executor the backend launches so an
// `mxcBinaryPath` override is checked too.
function probeMxcIsolationTier(
  executablePath: string,
  deps: ReadinessDeps,
): { tier: string; warnings: string[] } {
  const notReady = (reason: string, cause?: unknown) =>
    new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: ${reason}. ` +
        `Run "${executablePath}" --probe for host details.`,
      cause === undefined ? undefined : { cause },
    );
  let output: string;
  try {
    output = deps.execFileSync(executablePath, ["--probe"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 15_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
    throw notReady(`the MXC host probe failed${detail}`, error);
  }
  let probe: unknown;
  try {
    probe = JSON.parse(output);
  } catch (error) {
    throw notReady("the MXC host probe did not return JSON", error);
  }
  const parsed = MxcProbeOutputSchema.safeParse(probe);
  if (!parsed.success) {
    throw notReady("the MXC host probe returned an unexpected result", parsed.error);
  }
  const { tier, warnings, error } = parsed.data;
  if (!tier) {
    const reason = error || "the probe reported no isolation tier";
    throw notReady(`MXC cannot select an isolation tier on this host (${reason})`);
  }
  return { tier, warnings };
}

// AppContainer processes need directory-traversal/list rights on the system
// drive root (C:\) to enumerate directories inside the sandbox.
// `wxc-host-prep prepare-system-drive` adds ACEs for the well-known
// ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES
// (S-1-15-2-2) SIDs. Without this, directory listing (e.g. `dir`) inside the
// sandbox fails with "Access is denied". This is advisory: the sandbox still
// runs basic cmd.exe read/write workloads without it, so a missing grant warns
// rather than blocking activation.
function isSystemDrivePrepared(deps: ReadinessDeps): boolean {
  const systemDrive = process.env.SystemDrive || "C:";
  let output: string;
  try {
    output = deps.execFileSync(resolveWindowsSystemExecutable("icacls.exe"), [`${systemDrive}\\`], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    // If icacls itself fails, assume prepared rather than emitting a spurious
    // warning on a host we cannot probe.
    return true;
  }
  // Look for the well-known ALL APPLICATION PACKAGES SID (S-1-15-2-1) or its
  // display name. Both forms can appear depending on OS locale/version.
  return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES");
}

function systemDrivePrepWarning(systemDrive: string): string {
  return (
    `[mxc] MXC sandbox host preparation incomplete: the system drive root (${systemDrive}\\) ` +
    `does not grant directory access to AppContainer processes, so directory listing ` +
    `(e.g. \`dir\`) inside the sandbox will fail with "Access is denied". Basic read/write ` +
    `workloads still run.\n` +
    `Fix (one-time, elevated): wxc-host-prep prepare-system-drive (ships with @microsoft/mxc-sdk).`
  );
}

/**
 * Emits an advisory warning when the system drive is not prepared for
 * AppContainer directory access. Non-fatal: the sandbox still activates.
 */
export function warnMxcHostPrepIfNeeded(
  params: {
    platform?: NodeJS.Platform;
    deps?: Partial<ReadinessDeps>;
    warn?: (message: string) => void;
  } = {},
): void {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return;
  }
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  if (!isSystemDrivePrepared(deps)) {
    const warn = params.warn ?? ((message: string) => console.warn(message));
    warn(systemDrivePrepWarning(process.env.SystemDrive || "C:"));
  }
}

/**
 * Fails plugin activation unless MXC's host probe selects an isolation tier for
 * `executablePath`. Degradation warnings from the probe are reported but do not
 * block activation.
 */
export function assertMxcReadiness(params: {
  executablePath: string;
  platform?: NodeJS.Platform;
  deps?: Partial<ReadinessDeps>;
  warn?: (message: string) => void;
}): void {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return;
  }
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  const probe = probeMxcIsolationTier(params.executablePath, deps);
  if (probe.warnings.length > 0) {
    const warn = params.warn ?? ((message: string) => console.warn(message));
    warn(
      `[mxc] MXC sandbox is using the ${probe.tier} isolation tier: ${probe.warnings.join("; ")}`,
    );
  }
}
